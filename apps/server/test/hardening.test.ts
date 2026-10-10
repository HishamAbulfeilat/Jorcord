import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Intents, Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { safePost } from '../src/lib/safepost';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ allowPrivateUnfurl: true }); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Hard' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: any[] = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  return { owner, guild, code, general: guild.channels.find((c: any) => c.name === 'general'), members };
}
const botReq = (method: string, url: string, token: string, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${token}` });
async function appInGuild(owner: any, guild: any, perms: bigint = Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY) {
  const app = (await api.req('POST', '/applications', owner.token, { name: 'hbot', redirectUris: ['https://app.example/cb'] })).body;
  const authz = await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: perms.toString(), guildId: guild.id });
  expect(authz.status).toBe(200);
  return { app, botToken: app.token as string, botId: app.botUser.id as string };
}
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe('server issues from e2e/SERVER_ISSUES.md', () => {
  it('treats an empty JSON body as {} (bot libraries always send content-type)', async () => {
    const o = await api.register('empty');
    const app = (await api.req('POST', '/applications', o.token, { name: 'E' })).body;
    const r = await env.app.inject({ method: 'POST', url: `/api/v1/applications/${app.id}/bot/reset-token`, headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(200); expect(r.json().token).toBeTruthy();
    const w = await env.app.inject({ method: 'POST', url: `/api/v1/applications/${app.id}/bot/reset-token`, headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }, payload: '  ' });
    expect(w.statusCode).toBe(200);
    // malformed JSON and prototype poisoning are still rejected
    const bad = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(bad.statusCode).toBe(400);
    const poison = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"__proto__":{"x":1}}' });
    expect(poison.statusCode).toBe(400);
  });

  it('poll vote events carry the answer count and the distinct-voter total', async () => {
    const { guild, general, members } = await guildWith('p1', 'p2');
    const [p1, p2] = members;
    const ws = await WsClient.connect(env.port); await ws.identify(p2.token);
    const m = (await api.req('POST', `/channels/${general.id}/messages`, p1.token, { poll: { question: 'q', answers: [{ text: 'a' }, { text: 'b' }], allowMultiselect: true } })).body;
    const vote = (u: any, ids: number[]) => api.req('PUT', `/channels/${general.id}/polls/${m.id}/votes`, u.token, { answerIds: ids });
    await vote(p1, [1, 2]); await vote(p2, [1]);
    const add = await ws.waitEvent('MESSAGE_POLL_VOTE_ADD', (d) => d.userId === p2.id && d.answerId === 1);
    expect(add.d).toMatchObject({ count: 2, totalVotes: 2 });
    await vote(p1, [2]);
    const rem = await ws.waitEvent('MESSAGE_POLL_VOTE_REMOVE', (d) => d.userId === p1.id && d.answerId === 1);
    expect(rem.d).toMatchObject({ count: 1, totalVotes: 2 });
    await api.req('DELETE', `/channels/${general.id}/polls/${m.id}/votes/@me`, p2.token);
    const del = await ws.waitEvent('MESSAGE_POLL_VOTE_REMOVE', (d) => d.userId === p2.id);
    expect(del.d).toMatchObject({ count: 0, totalVotes: 1 });
    void guild; ws.close();
  });

  it('registering a global command notifies every server the app is installed in', async () => {
    const { owner, guild } = await guildWith();
    const { app, botToken } = await appInGuild(owner, guild);
    const other = await api.register('nobody'); // not in the guild: must hear nothing
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    const ows = await WsClient.connect(env.port); await ows.identify(other.token);
    const c = await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: 'global', description: 'g' });
    expect(c.status).toBe(201);
    const ev = await ws.waitEvent('APPLICATION_COMMAND_CREATE', (d) => d.id === c.body.id);
    expect(ev.d.guildId).toBeNull();
    await botReq('PATCH', `/applications/${app.id}/commands/${c.body.id}`, botToken, { description: 'g2' });
    await ws.waitEvent('APPLICATION_COMMAND_UPDATE', (d) => d.id === c.body.id && d.description === 'g2');
    await botReq('DELETE', `/applications/${app.id}/commands/${c.body.id}`, botToken);
    await ws.waitEvent('APPLICATION_COMMAND_DELETE', (d) => d.id === c.body.id);
    await ows.expectNone((f) => String(f.t).startsWith('APPLICATION_COMMAND_'));
    ws.close(); ows.close();
  });

  it('locked threads stop non-moderators from posting, open or archived', async () => {
    const { owner, general, members } = await guildWith('lk');
    const talker = members[0];
    const m = (await api.req('POST', `/channels/${general.id}/messages`, talker.token, { content: 'start' })).body;
    const th = (await api.req('POST', `/channels/${general.id}/messages/${m.id}/threads`, talker.token, { name: 't' })).body;
    expect((await api.req('POST', `/channels/${th.id}/messages`, talker.token, { content: 'ok' })).status).toBe(201);
    await api.req('PATCH', `/channels/${th.id}`, owner.token, { locked: true });
    const blocked = await api.req('POST', `/channels/${th.id}/messages`, talker.token, { content: 'still open?' });
    expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('THREAD_LOCKED');
    expect((await api.req('POST', `/channels/${th.id}/messages`, owner.token, { content: 'mod can' })).status).toBe(201);
    await api.req('PATCH', `/channels/${th.id}`, owner.token, { locked: false });
    expect((await api.req('POST', `/channels/${th.id}/messages`, talker.token, { content: 'unlocked' })).status).toBe(201);
  });
});

describe('security regressions', () => {
  it('scheduled events: a non-member cannot delete an event; members need MANAGE_EVENTS or to be the creator', async () => {
    const { owner, guild, members } = await guildWith('mem');
    const e = (await api.req('POST', `/guilds/${guild.id}/scheduled-events`, owner.token, { name: 'Meet', entityType: 3, scheduledStartTime: inHours(2), scheduledEndTime: inHours(3), location: 'here' })).body;
    const stranger = await api.register('stranger');
    expect((await api.req('DELETE', `/guilds/${guild.id}/scheduled-events/${e.id}`, stranger.token)).status).toBe(404);
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, stranger.token, { name: 'pwn' })).status).toBe(404);
    expect((await api.req('DELETE', `/guilds/${guild.id}/scheduled-events/${e.id}`, members[0].token)).status).toBe(403);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token)).body.name).toBe('Meet');
    expect((await api.req('DELETE', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token)).status).toBe(204);
  });

  it('bots cannot join servers by invite or discovery, create servers or boost; installs go through OAuth only', async () => {
    const { owner, guild, code } = await guildWith();
    await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { discoverable: true });
    const app = (await api.req('POST', '/applications', owner.token, { name: 'sneaky' })).body;
    for (const [m, u] of [['POST', `/invites/${code}`], ['POST', `/discover/guilds/${guild.id}/join`], ['POST', `/guilds/${guild.id}/join`], ['POST', '/guilds'], ['POST', `/guilds/${guild.id}/boosts`]] as const) {
      const r = await botReq(m, u, app.token, m === 'POST' && u === '/guilds' ? { name: 'x' } : undefined);
      expect(r.status, `${m} ${u}`).toBe(403);
    }
    expect((await env.ctx.db.query('SELECT 1 FROM members WHERE user_id = $1', [app.botUser.id])).length).toBe(0);
  });

  it('OAuth2 PKCE: S256 only, verifier required when a challenge was given, wrong verifier burns the code', async () => {
    const dev = await api.register('pk'), user = await api.register('pku');
    const app = (await api.req('POST', '/applications', dev.token, { name: 'Pkce', redirectUris: ['https://app.example/cb'] })).body;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authz = (extra: object) => api.req('POST', '/oauth2/authorize', user.token, { clientId: app.id, scope: 'identify', redirectUri: 'https://app.example/cb', ...extra });
    const tok = (code: string, extra: object = {}) => api.req('POST', '/oauth2/token', null, { clientId: app.id, clientSecret: app.clientSecret, grantType: 'authorization_code', code, redirectUri: 'https://app.example/cb', ...extra });
    expect((await authz({ codeChallenge: challenge, codeChallengeMethod: 'plain' })).status).toBe(400); // no downgrade
    expect((await authz({ codeChallenge: challenge })).status).toBe(400);
    expect((await authz({ codeChallenge: 'short', codeChallengeMethod: 'S256' })).status).toBe(400);
    const a1 = await authz({ codeChallenge: challenge, codeChallengeMethod: 'S256' });
    expect(a1.status).toBe(200);
    expect((await tok(a1.body.code)).status).toBe(400); // no verifier -> burned
    expect((await tok(a1.body.code, { codeVerifier: verifier })).status).toBe(400);
    const a2 = await authz({ codeChallenge: challenge, codeChallengeMethod: 'S256' });
    expect((await tok(a2.body.code, { codeVerifier: randomBytes(32).toString('base64url') })).status).toBe(400);
    expect((await tok(a2.body.code, { codeVerifier: verifier })).status).toBe(400); // wrong guess burned the code
    const a3 = await authz({ codeChallenge: challenge, codeChallengeMethod: 'S256' });
    const ok = await tok(a3.body.code, { codeVerifier: verifier });
    expect(ok.status).toBe(200); expect(ok.body.accessToken).toMatch(/^jco_/);
    const [row] = await env.ctx.db.query('SELECT code_challenge FROM oauth_codes ORDER BY expires_at DESC LIMIT 1');
    expect(row.code_challenge).toBe(challenge); // only the challenge is stored, never the verifier
    // without PKCE the classic flow still works
    const a4 = await authz({});
    expect((await tok(a4.body.code)).status).toBe(200);
  });

  it('redirect URIs must be https (http only for loopback)', async () => {
    const dev = await api.register('ru');
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://u:p@x.example/cb', 'https://x.example/cb#frag']) expect((await api.req('POST', '/applications', dev.token, { name: 'R', redirectUris: [uri] })).status, uri).toBe(400);
    for (const uri of ['https://x.example/cb', 'http://localhost:3000/cb', 'http://127.0.0.1:5173/cb']) expect((await api.req('POST', '/applications', dev.token, { name: 'R', redirectUris: [uri] })).status, uri).toBe(201);
  });

  it('private bots cannot be given command access by strangers either', async () => {
    const { owner, guild, members } = await guildWith('mgr');
    const app = (await api.req('POST', '/applications', owner.token, { name: 'priv', botPublic: false })).body;
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'mgr', permissions: Perm.MANAGE_GUILD.toString() })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${members[0].id}`, owner.token, { roles: [role.id] });
    expect((await api.req('POST', '/oauth2/authorize', members[0].token, { clientId: app.id, scope: 'applications.commands', guildId: guild.id })).status).toBe(404);
    expect((await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'applications.commands', guildId: guild.id })).status).toBe(200);
  });

  it('interactions endpoint: standard ports only for public hosts (no port scanning)', async () => {
    await expect(safePost('http://example.com:6379/', '{}', {})).rejects.toThrow('SSRF_BLOCKED');
    await expect(safePost('http://example.com:22/', '{}', {})).rejects.toThrow('SSRF_BLOCKED');
    await expect(safePost('http://169.254.169.254/', '{}', {})).rejects.toThrow('SSRF_BLOCKED');
    await expect(safePost('http://[::ffff:7f00:1]/', '{}', {})).rejects.toThrow('SSRF_BLOCKED');
  });

  it('timed-out or screening-pending members cannot press components or vote in polls', async () => {
    const { owner, guild, general, members } = await guildWith('mute');
    const victim = members[0];
    const { app, botToken } = await appInGuild(owner, guild);
    const msg = (await botReq('POST', `/channels/${general.id}/messages`, botToken, { content: 'btn', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Go', customId: 'go' }] }] })).body;
    const poll = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { poll: { question: 'q', answers: [{ text: 'a' }, { text: 'b' }] } })).body;
    const press = () => api.req('POST', '/interactions', victim.token, { type: 3, channelId: general.id, messageId: msg.id, data: { customId: 'go' } });
    const vote = () => api.req('PUT', `/channels/${general.id}/polls/${poll.id}/votes`, victim.token, { answerIds: [1] });
    expect((await press()).status).toBe(202); expect((await vote()).status).toBe(200);
    await env.ctx.db.query(`UPDATE members SET timeout_until = now() + interval '1 hour' WHERE guild_id = $1 AND user_id = $2`, [guild.id, victim.id]);
    await env.ctx.pcache.invalidate({ k: 'member', guildId: guild.id, userId: victim.id });
    expect((await press()).status).toBe(403);
    expect((await vote()).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${general.id}/polls/${poll.id}/votes/@me`, victim.token)).status).toBe(403);
    void app;
  });

  it('message-targeted interactions need READ_MESSAGE_HISTORY', async () => {
    const { owner, guild, general, members } = await guildWith('nohist');
    const u = members[0];
    const { app, botToken } = await appInGuild(owner, guild);
    const cmd = (await botReq('POST', `/applications/${app.id}/commands`, botToken, { type: 3, name: 'Peek' })).body;
    const target = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'private-ish' })).body;
    const invoke = () => api.req('POST', '/interactions', u.token, { type: 2, channelId: general.id, data: { id: cmd.id, targetId: target.id } });
    expect((await invoke()).status).toBe(202);
    await api.req('PUT', `/channels/${general.id}/permissions/${u.id}`, owner.token, { type: 'member', allow: '0', deny: Perm.READ_MESSAGE_HISTORY.toString() });
    expect((await invoke()).status).toBe(403);
  });

  it('unauthenticated callers cannot exhaust an interaction\'s rate bucket to block the app', async () => {
    const strict = await startServer({ rateLimit: true });
    try {
      const a = new Api(strict);
      const owner = await a.register('rl');
      const guild = (await a.req('POST', '/guilds', owner.token, { name: 'RL' })).body;
      const general = guild.channels.find((c: any) => c.name === 'general');
      const app = (await a.req('POST', '/applications', owner.token, { name: 'rlbot' })).body;
      await a.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES).toString(), guildId: guild.id });
      const cmd = (await a.req('POST', `/applications/${app.id}/commands`, null, { name: 'hi', description: 'd' }, { authorization: `Bot ${app.token}` })).body;
      const ws = await WsClient.connect(strict.port); await ws.identify(`Bot ${app.token}`);
      const inv = await a.req('POST', '/interactions', owner.token, { type: 2, channelId: general.id, data: { id: cmd.id } });
      expect(inv.status).toBe(202);
      const ev = await ws.waitEvent('INTERACTION_CREATE', (d) => d.id === inv.body.id);
      const url = `/api/v1/interactions/${inv.body.id}/${ev.d.token}/callback`;
      const bad = `/api/v1/interactions/${inv.body.id}/${'x'.repeat(43)}/callback`;
      for (let ip = 1; ip <= 4; ip++) for (let i = 0; i < 25; i++) await strict.app.inject({ method: 'POST', url: bad, remoteAddress: `10.9.0.${ip}`, payload: { type: 4, data: { content: 'x' } } }); // 100 wrong-token calls from 4 sources
      const good = await strict.app.inject({ method: 'POST', url, remoteAddress: '10.9.0.99', payload: { type: 4, data: { content: 'pong' } } });
      expect(good.statusCode).toBe(204);
      ws.close();
    } finally { await strict.close(); }
  });
});

describe('gateway intents', () => {
  async function setup() {
    const { owner, guild, general, members } = await guildWith('talker');
    const { app, botToken, botId } = await appInGuild(owner, guild);
    return { owner, guild, general, talker: members[0], app, botToken, botId };
  }
  const identifyRaw = async (token: string, intents?: number) => {
    const ws = await WsClient.connect(env.port);
    await ws.waitFor((f) => f.op === 10);
    ws.send({ op: 2, d: { token, ...(intents !== undefined ? { intents } : {}) } });
    return ws;
  };

  it('rejects unknown intent bits (4013) and privileged intents the owner has not enabled (4014)', async () => {
    const { app, owner, botToken } = await setup();
    expect((await (await identifyRaw(`Bot ${botToken}`, 1 << 30)).waitClose()).code).toBe(4013);
    for (const bit of [Intents.GUILD_MEMBERS, Intents.GUILD_PRESENCES, Intents.MESSAGE_CONTENT]) expect((await (await identifyRaw(`Bot ${botToken}`, Intents.GUILDS | bit)).waitClose()).code).toBe(4014);
    // owner switches on exactly one privileged intent
    expect((await api.req('PATCH', `/applications/${app.id}`, owner.token, { privilegedIntents: Intents.GUILD_PRESENCES | Intents.MESSAGE_CONTENT | 1 })).status).toBe(400); // non-privileged bit in the field
    const patched = await api.req('PATCH', `/applications/${app.id}`, owner.token, { privilegedIntents: Intents.MESSAGE_CONTENT });
    expect(patched.body.privilegedIntents).toBe(Intents.MESSAGE_CONTENT);
    const ok = await identifyRaw(`Bot ${botToken}`, Intents.GUILD_MESSAGES | Intents.MESSAGE_CONTENT); await ok.waitEvent('READY');
    expect((await (await identifyRaw(`Bot ${botToken}`, Intents.GUILD_MEMBERS)).waitClose()).code).toBe(4014);
    ok.close();
  });

  it('filters events by intent, redacts message content without MESSAGE_CONTENT and trims members without GUILD_MEMBERS', async () => {
    const { owner, guild, general, talker, app, botToken, botId } = await setup();
    const legacy = await identifyRaw(`Bot ${botToken}`); const lready = await legacy.waitEvent('READY');
    const guildsOnly = await identifyRaw(`Bot ${botToken}`, Intents.GUILDS); const gready = await guildsOnly.waitEvent('READY');
    const msgs = await identifyRaw(`Bot ${botToken}`, Intents.GUILD_MESSAGES | Intents.GUILD_MESSAGE_TYPING); await msgs.waitEvent('READY');
    // READY: legacy sees every member, intent sessions only themselves; memberCount stays honest
    expect(lready.d.guilds[0].members.length).toBe(3);
    expect(gready.d.guilds[0].members.map((m: any) => m.user.id)).toEqual([botId]);
    expect(gready.d.guilds[0].memberCount).toBe(3);
    expect(gready.d.presences).toEqual([]);

    await api.req('POST', `/channels/${general.id}/messages`, talker.token, { content: 'plain chatter' });
    await api.req('POST', `/channels/${general.id}/messages`, talker.token, { content: `hey <@${botId}> you there` });
    const m1 = await legacy.waitEvent('MESSAGE_CREATE', (d) => d.content === 'plain chatter');
    expect(m1.d.content).toBe('plain chatter');
    const redacted = await msgs.waitEvent('MESSAGE_CREATE', (d) => d.author.id === talker.id && d.content === '');
    expect(redacted.d.embeds).toEqual([]);
    await msgs.waitEvent('MESSAGE_CREATE', (d) => d.content.includes('you there')); // mentions of the bot keep their text
    await guildsOnly.expectNone((f) => f.t === 'MESSAGE_CREATE');
    // typing needs its own intent, member events need GUILD_MEMBERS, channel events need GUILDS
    const ws = await WsClient.connect(env.port); await ws.identify(talker.token);
    ws.send({ op: 9, d: { channelId: general.id } });
    await msgs.waitEvent('TYPING_START'); await guildsOnly.expectNone((f) => f.t === 'TYPING_START');
    const newcomer = await api.register('late');
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, newcomer.token);
    await legacy.waitEvent('MEMBER_ADD', (d) => d.user.id === newcomer.id);
    await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'newchan', type: 'text' });
    await guildsOnly.waitEvent('CHANNEL_CREATE', (d) => d.name === 'newchan');
    await msgs.expectNone((f) => f.t === 'CHANNEL_CREATE' || f.t === 'MEMBER_ADD');
    await guildsOnly.expectNone((f) => f.t === 'MEMBER_ADD');
    // interactions always flow, whatever the intents
    const cmd = (await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: 'ix', description: 'd' })).body;
    const inv = await api.req('POST', '/interactions', talker.token, { type: 2, channelId: general.id, data: { id: cmd.id } });
    await guildsOnly.waitEvent('INTERACTION_CREATE', (d) => d.id === inv.body.id);
    // REQUEST_MEMBERS needs the GUILD_MEMBERS intent once intents are in use
    guildsOnly.send({ op: 8, d: { guildId: guild.id } });
    expect((await guildsOnly.waitEvent('ERROR')).d.code).toBe('MISSING_INTENT');
    legacy.send({ op: 8, d: { guildId: guild.id } });
    expect((await legacy.waitEvent('GUILD_MEMBERS_CHUNK')).d.members.length).toBeGreaterThan(2);
    for (const c of [legacy, guildsOnly, msgs, ws]) c.close();
  });

  it('user sessions ignore intents and keep receiving everything', async () => {
    const { talker, general } = await setup();
    const ws = await WsClient.connect(env.port); await ws.waitFor((f) => f.op === 10);
    ws.send({ op: 2, d: { token: talker.token, intents: Intents.GUILDS } }); await ws.waitEvent('READY');
    await api.req('POST', `/channels/${general.id}/messages`, talker.token, { content: 'mine' });
    await ws.waitEvent('MESSAGE_CREATE', (d) => d.content === 'mine');
    ws.close();
  });

  it('dropping a privileged intent from the application disconnects sessions that used it', async () => {
    const { app, owner, botToken } = await setup();
    await api.req('PATCH', `/applications/${app.id}`, owner.token, { privilegedIntents: Intents.MESSAGE_CONTENT });
    const ws = await identifyRaw(`Bot ${botToken}`, Intents.GUILD_MESSAGES | Intents.MESSAGE_CONTENT); await ws.waitEvent('READY');
    await api.req('PATCH', `/applications/${app.id}`, owner.token, { privilegedIntents: 0 });
    expect((await ws.waitClose()).code).toBe(4004);
  });
});
