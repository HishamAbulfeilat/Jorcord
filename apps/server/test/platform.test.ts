import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditActionType, DEFAULT_EVERYONE, DISCORD_PERMISSION_BITS, ErrorCode, Perm, type PermName } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { verifyInteractionSignature } from '../src/lib/interactionSig';
import { runSweeps } from '../src/services/sweeper';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ allowPrivateUnfurl: true }); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Plat' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const ch = (name: string) => guild.channels.find((c: any) => c.name === name);
  return { owner, guild, general: ch('general'), voice: ch('General') as any, members };
}
const botReq = (method: string, url: string, token: string, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${token}` });

/** Create an application and install its bot (+commands scope) into a guild. */
async function appInGuild(owner: any, guild: any, perms: bigint = Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY) {
  const created = await api.req('POST', '/applications', owner.token, { name: 'testbot', redirectUris: ['https://app.example/cb'] });
  expect(created.status).toBe(201);
  const app = created.body;
  const authz = await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: perms.toString(), guildId: guild.id });
  expect(authz.status).toBe(200);
  return { app, botToken: app.token as string, botId: app.botUser.id as string };
}
const slash = { name: 'ping', description: 'Ping pong', options: [{ type: 3, name: 'text', description: 'Say', required: true }] };

describe('permissions: Jorcord bit layout is intentional and mapped', () => {
  it('has unique bits, documents a Discord position for every one, and grants new bits to @everyone', () => {
    const bits = Object.values(Perm).map((b) => b.toString(2).length - 1);
    expect(new Set(bits).size).toBe(bits.length);
    for (const k of Object.keys(Perm) as PermName[]) expect(typeof DISCORD_PERMISSION_BITS[k]).toBe('number');
    expect(Perm.SEND_POLLS).toBe(1n << 41n); // Jorcord's own position
    expect(DISCORD_PERMISSION_BITS.SEND_POLLS).toBe(49); // Discord's
    expect(DEFAULT_EVERYONE & Perm.SEND_POLLS).toBe(Perm.SEND_POLLS);
    expect(DEFAULT_EVERYONE & Perm.CREATE_EVENTS).toBe(0n);
  });
});

describe('applications and bots', () => {
  it('creates an app; the bot token is shown once, stored hashed, and authenticates REST', async () => {
    const owner = await api.register('dev');
    const r = await api.req('POST', '/applications', owner.token, { name: 'Helper' });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[\w-]+\.[\w-]{40,}$/);
    expect(r.body.clientSecret).toBeTruthy();
    expect(r.body.botUser.bot).toBe(true);
    expect(r.body.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // never again
    const again = await api.req('GET', `/applications/${r.body.id}`, owner.token);
    expect(again.body.token).toBeUndefined(); expect(again.body.clientSecret).toBeUndefined();
    expect(JSON.stringify((await api.req('GET', '/applications', owner.token)).body)).not.toContain(r.body.token);
    const [row] = await env.ctx.db.query('SELECT * FROM applications WHERE id = $1', [r.body.id]);
    expect(JSON.stringify(row)).not.toContain(r.body.token);
    expect(JSON.stringify(row)).not.toContain(r.body.clientSecret);
    expect(row.bot_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.private_key_enc).not.toMatch(/MC4CAQAw/); // PKCS8 header: must be encrypted
    const me = await botReq('GET', '/users/@me', r.body.token);
    expect(me.status).toBe(200); expect(me.body.id).toBe(r.body.botUser.id); expect(me.body.bot).toBe(true);
    expect((await botReq('GET', '/applications/@me', r.body.token)).body.id).toBe(r.body.id);
  });

  it('rejects bad / foreign tokens, hides apps from non-owners and keeps bots off human-only endpoints', async () => {
    const a = await api.register('a'), b = await api.register('b');
    const app = (await api.req('POST', '/applications', a.token, { name: 'Mine' })).body;
    expect((await botReq('GET', '/users/@me', app.token + 'x')).status).toBe(401);
    expect((await botReq('GET', '/users/@me', 'garbage')).status).toBe(401);
    expect((await api.req('GET', `/applications/${app.id}`, b.token)).status).toBe(404);
    expect((await api.req('PATCH', `/applications/${app.id}`, b.token, { name: 'x' })).status).toBe(404);
    expect((await api.req('POST', `/applications/${app.id}/bot/reset-token`, b.token)).status).toBe(404);
    expect((await api.req('DELETE', `/applications/${app.id}`, b.token)).status).toBe(404);
    expect((await botReq('GET', '/applications', app.token)).status).toBe(403);
    const sess = await botReq('GET', '/auth/sessions', app.token);
    expect(sess.status).toBe(403); expect(sess.body.errorCode).toBe(20001);
    expect((await botReq('GET', '/users/@me/relationships', app.token)).status).toBe(403);
    expect((await botReq('POST', '/applications', app.token, { name: 'child' })).status).toBe(403);
    expect((await api.req('POST', '/applications', a.token, { name: '', extra: 1 })).status).toBe(400);
  });

  it('regenerating the token invalidates the old one and drops live gateway sessions', async () => {
    const o = await api.register('regen');
    const app = (await api.req('POST', '/applications', o.token, { name: 'Regen' })).body;
    const ws = await WsClient.connect(env.port);
    const ready = await ws.identify(`Bot ${app.token}`);
    expect(ready.d.user.id).toBe(app.botUser.id);
    const r = await api.req('POST', `/applications/${app.id}/bot/reset-token`, o.token);
    expect(r.status).toBe(200); expect(r.body.token).not.toBe(app.token);
    expect((await ws.waitClose()).code).toBe(4004);
    expect((await botReq('GET', '/users/@me', app.token)).status).toBe(401);
    expect((await botReq('GET', '/users/@me', r.body.token)).status).toBe(200);
    const bad = await WsClient.connect(env.port);
    await bad.waitFor((f) => f.op === 10); bad.send({ op: 2, d: { token: `Bot ${app.token}` } });
    expect((await bad.waitClose()).code).toBe(4004);
  });

  it('deleting an application removes its bot from guilds and kills its token', async () => {
    const { owner, guild } = await guildWith();
    const { app, botToken, botId } = await appInGuild(owner, guild);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${botId}`, owner.token)).status).toBe(200);
    expect((await api.req('DELETE', `/applications/${app.id}`, owner.token)).status).toBe(204);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${botId}`, owner.token)).status).toBe(404);
    expect((await botReq('GET', '/users/@me', botToken)).status).toBe(401);
  });
});

describe('OAuth2 authorize', () => {
  it('adds a bot with a managed role carrying only the chosen permissions; managers only; no escalation', async () => {
    const { owner, guild, members } = await guildWith('plain', 'mgr');
    const app = (await api.req('POST', '/applications', owner.token, { name: 'Bot2' })).body;
    const [plain, mgr] = members as any[];
    const perms = (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES).toString();
    // preview lists only guilds the user can manage
    const prev = await api.req('GET', `/oauth2/authorize?clientId=${app.id}&scope=bot%20applications.commands&permissions=${perms}`, owner.token);
    expect(prev.status).toBe(200);
    expect(prev.body.guilds.map((g: any) => g.id)).toContain(guild.id);
    expect((await api.req('GET', `/oauth2/authorize?clientId=${app.id}&scope=bot`, plain.token)).body.guilds).toEqual([]);
    const body = { clientId: app.id, scope: 'bot applications.commands', permissions: perms, guildId: guild.id };
    expect((await api.req('POST', '/oauth2/authorize', plain.token, body)).status).toBe(403); // no MANAGE_GUILD
    expect((await api.req('POST', '/oauth2/authorize', owner.token, { ...body, scope: 'bot nonsense' })).status).toBe(400);
    // a manager without ADMINISTRATOR cannot delegate what they do not hold
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'manager', permissions: (Perm.MANAGE_GUILD | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.MANAGE_ROLES).toString() })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${mgr.id}`, owner.token, { roles: [role.id] });
    const esc = await api.req('POST', '/oauth2/authorize', mgr.token, { ...body, permissions: (Perm.VIEW_CHANNEL | Perm.BAN_MEMBERS).toString() });
    expect(esc.status).toBe(403); expect(esc.body.code).toBe('PERMISSION_ESCALATION');
    const ws = await WsClient.connect(env.port);
    await ws.identify(`Bot ${app.token}`);
    const ok = await api.req('POST', '/oauth2/authorize', mgr.token, body);
    expect(ok.status).toBe(200); expect(ok.body.guildId).toBe(guild.id);
    const g = await ws.waitEvent('GUILD_CREATE', (d) => d.id === guild.id);
    expect(g.d.members.some((m: any) => m.user.id === app.botUser.id)).toBe(true);
    const roles = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body;
    const managed = roles.find((r: any) => r.name === 'Bot2');
    expect(managed.permissions).toBe(perms);
    expect(managed.position).toBe(1);
    const bm = (await api.req('GET', `/guilds/${guild.id}/members/${app.botUser.id}`, owner.token)).body;
    expect(bm.roles).toEqual([managed.id]);
    // audit + managed role cannot be deleted by hand
    const log = (await api.req('GET', `/guilds/${guild.id}/audit-logs?actionType=${AuditActionType.BOT_ADD}`, owner.token)).body;
    expect(log[0].action).toBe('BOT_ADD'); expect(log[0].actionType).toBe(28);
    expect((await api.req('DELETE', `/guilds/${guild.id}/roles/${managed.id}`, owner.token)).status).toBe(400);
    // kicking the bot removes the role and install
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${app.botUser.id}`, owner.token)).status).toBe(204);
    expect((await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.some((r: any) => r.id === managed.id)).toBe(false);
    ws.close();
  });

  it('private bots can only be added by their owner', async () => {
    const { owner, guild } = await guildWith();
    const other = await api.register('dev2');
    const app = (await api.req('POST', '/applications', other.token, { name: 'Priv', botPublic: false })).body;
    expect((await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot', guildId: guild.id })).status).toBe(404);
  });

  it('identify scope: exact redirect uri, single-use code, client secret required, /oauth2/@me', async () => {
    const user = await api.register('ident');
    const dev = await api.register('dev3');
    const app = (await api.req('POST', '/applications', dev.token, { name: 'Login', redirectUris: ['https://app.example/cb'] })).body;
    expect((await api.req('POST', '/oauth2/authorize', user.token, { clientId: app.id, scope: 'identify', redirectUri: 'https://evil.example/cb' })).status).toBe(400);
    const a = await api.req('POST', '/oauth2/authorize', user.token, { clientId: app.id, scope: 'identify', redirectUri: 'https://app.example/cb', state: 'xyz' });
    expect(a.status).toBe(200); expect(a.body.state).toBe('xyz');
    const [stored] = await env.ctx.db.query('SELECT code_hash FROM oauth_codes WHERE application_id = $1', [app.id]);
    expect(stored.code_hash).not.toBe(a.body.code);
    const tok = { clientId: app.id, clientSecret: app.clientSecret, grantType: 'authorization_code', code: a.body.code, redirectUri: 'https://app.example/cb' };
    expect((await api.req('POST', '/oauth2/token', null, { ...tok, clientSecret: 'wrong' })).status).toBe(401);
    expect((await api.req('POST', '/oauth2/token', null, { ...tok, redirectUri: 'https://app.example/other' })).status).toBe(400); // a mismatch burns the code
    expect((await api.req('POST', '/oauth2/token', null, tok)).status).toBe(400);
    tok.code = (await api.req('POST', '/oauth2/authorize', user.token, { clientId: app.id, scope: 'identify', redirectUri: 'https://app.example/cb' })).body.code;
    const t = await api.req('POST', '/oauth2/token', null, tok);
    expect(t.status).toBe(200); expect(t.body.scope).toBe('identify');
    expect((await api.req('POST', '/oauth2/token', null, tok)).status).toBe(400); // used
    const me = await api.req('GET', '/oauth2/@me', null, undefined, { authorization: `Bearer ${t.body.accessToken}` });
    expect(me.body.user.id).toBe(user.id); expect(me.body.user.email).toBeUndefined();
    // an OAuth token is not an API credential
    expect((await api.req('GET', '/users/@me', null, undefined, { authorization: `Bearer ${t.body.accessToken}` })).status).toBe(401);
    expect((await api.req('POST', '/oauth2/token/revoke', null, { clientId: app.id, clientSecret: app.clientSecret, token: t.body.accessToken })).status).toBe(200);
    expect((await api.req('GET', '/oauth2/@me', null, undefined, { authorization: `Bearer ${t.body.accessToken}` })).status).toBe(401);
  });
});

describe('application commands', () => {
  it('validates, upserts, limits, bulk-overwrites and requires installation for guild scope', async () => {
    const { owner, guild } = await guildWith();
    const { app, botToken } = await appInGuild(owner, guild);
    const c = await botReq('POST', `/applications/${app.id}/commands`, botToken, slash);
    expect(c.status).toBe(201); expect(c.body.type).toBe(1);
    const up = await botReq('POST', `/applications/${app.id}/commands`, botToken, { ...slash, description: 'changed' });
    expect(up.status).toBe(200); expect(up.body.id).toBe(c.body.id); expect(up.body.version).not.toBe(c.body.version);
    for (const bad of [
      { name: 'Upper', description: 'x' }, { name: 'ok', description: '' }, { name: 'a b', description: 'x' },
      { name: 'ok2', description: 'x', options: [{ type: 3, name: 'o', description: 'd' }, { type: 3, name: 'r', description: 'd', required: true }] },
      { name: 'ok3', description: 'x', options: [{ type: 3, name: 'o', description: 'd', choices: [{ name: 'a', value: 1 }] }] },
      { name: 'ok4', description: 'x', options: [{ type: 3, name: 'o', description: 'd', choices: [{ name: 'a', value: 'a' }], autocomplete: true }] },
      { name: 'ok5', description: 'x', options: [{ type: 1, name: 'sub', description: 'd' }, { type: 3, name: 'o', description: 'd' }] },
      { name: 'ok6', type: 2, description: 'no desc allowed' }, { name: 'ok7', description: 'x', bogus: true },
    ]) expect((await botReq('POST', `/applications/${app.id}/commands`, botToken, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: 'Ctx Menu', type: 3 })).status).toBe(201);
    // another app's token cannot touch these commands
    const other = await api.register('dev4');
    const app2 = (await api.req('POST', '/applications', other.token, { name: 'Other' })).body;
    expect((await botReq('GET', `/applications/${app.id}/commands`, app2.token)).status).toBe(404);
    expect((await botReq('DELETE', `/applications/${app.id}/commands/${c.body.id}`, app2.token)).status).toBe(404);
    // guild scope needs install
    expect((await botReq('POST', `/applications/${app2.id}/guilds/${guild.id}/commands`, app2.token, slash)).status).toBe(403);
    const g = await botReq('POST', `/applications/${app.id}/guilds/${guild.id}/commands`, botToken, { name: 'local', description: 'guild only' });
    expect(g.status).toBe(201); expect(g.body.guildId).toBe(guild.id);
    // bulk overwrite deletes what is omitted
    const bulk = await botReq('PUT', `/applications/${app.id}/commands`, botToken, [slash, { name: 'extra', description: 'e' }]);
    expect(bulk.status).toBe(200); expect(bulk.body.map((x: any) => x.name).sort()).toEqual(['extra', 'ping']);
    expect((await botReq('PUT', `/applications/${app.id}/commands`, botToken, [slash, slash])).status).toBe(400);
    expect((await botReq('GET', `/applications/${app.id}/guilds/${guild.id}/commands`, botToken)).body).toHaveLength(1);
    // slash command limit (15 for context menus)
    for (let i = 0; i < 15; i++) await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: `menu${i}`, type: 2 });
    const over = await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: 'menu99', type: 2 });
    expect(over.status).toBe(400); expect(over.body.errorCode).toBe(ErrorCode.MAX_APPLICATION_COMMANDS);
  });

  it('command permissions: default_member_permissions, role/user overwrites, channel denies', async () => {
    const { owner, guild, general, members } = await guildWith('plain', 'modr');
    const [plain, modr] = members as any[];
    const { app, botToken } = await appInGuild(owner, guild);
    const open = (await botReq('POST', `/applications/${app.id}/guilds/${guild.id}/commands`, botToken, { name: 'open', description: 'o' })).body;
    const locked = (await botReq('POST', `/applications/${app.id}/guilds/${guild.id}/commands`, botToken, { name: 'locked', description: 'l', defaultMemberPermissions: Perm.BAN_MEMBERS.toString() })).body;
    const names = async (u: any) => (await api.req('GET', `/guilds/${guild.id}/application-commands?channelId=${general.id}`, u.token)).body.commands.map((c: any) => c.name);
    expect(await names(plain)).toEqual(['open']);
    expect(await names(owner)).toEqual(['locked', 'open']);
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'mods' })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${modr.id}`, owner.token, { roles: [role.id] });
    // only guild managers on a user session may set permissions; bots may not
    expect((await botReq('PUT', `/applications/${app.id}/guilds/${guild.id}/commands/${locked.id}/permissions`, botToken, { permissions: [] })).status).toBe(403);
    expect((await api.req('PUT', `/applications/${app.id}/guilds/${guild.id}/commands/${locked.id}/permissions`, plain.token, { permissions: [] })).status).toBe(403);
    const put = await api.req('PUT', `/applications/${app.id}/guilds/${guild.id}/commands/${locked.id}/permissions`, owner.token, { permissions: [{ id: role.id, type: 1, permission: true }] });
    expect(put.status).toBe(200);
    expect(await names(modr)).toEqual(['locked', 'open']);
    expect(await names(plain)).toEqual(['open']);
    expect((await api.req('PUT', `/applications/${app.id}/guilds/${guild.id}/commands/${locked.id}/permissions`, owner.token, { permissions: [{ id: '123', type: 1, permission: true }] })).status).toBe(400); // foreign role
    // channel deny + user deny on the open command
    await api.req('PUT', `/applications/${app.id}/guilds/${guild.id}/commands/${open.id}/permissions`, owner.token, { permissions: [{ id: general.id, type: 3, permission: false }] });
    expect(await names(plain)).toEqual([]);
    // invocation enforces the same rule server-side
    const denied = await api.req('POST', '/interactions', plain.token, { type: 2, channelId: general.id, data: { id: open.id } });
    expect(denied.status).toBe(403);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?actionType=121`, owner.token)).body.length).toBeGreaterThan(0);
  });
});

describe('interactions over the gateway', () => {
  it('slash command: INTERACTION_CREATE to the bot, 15-min token, response, ephemeral isolation, followups', async () => {
    const { owner, guild, general, members } = await guildWith('caller', 'bystander');
    const [caller, bystander] = members as any[];
    const { app, botToken } = await appInGuild(owner, guild);
    const cmd = (await botReq('POST', `/applications/${app.id}/commands`, botToken, slash)).body;
    const bot = await WsClient.connect(env.port); await bot.identify(`Bot ${botToken}`);
    const callerWs = await WsClient.connect(env.port); await callerWs.identify(caller.token);
    const byWs = await WsClient.connect(env.port); await byWs.identify(bystander.token);

    // validation: server-side, from the stored definition (not trusting the client)
    const ok = { type: 2, channelId: general.id, data: { id: cmd.id, options: [{ name: 'text', type: 3, value: 'hello' }] } };
    expect((await api.req('POST', '/interactions', caller.token, { ...ok, data: { id: cmd.id, options: [] } })).status).toBe(400); // missing required
    expect((await api.req('POST', '/interactions', caller.token, { ...ok, data: { id: cmd.id, options: [{ name: 'text', type: 4, value: 1 }] } })).status).toBe(400);
    expect((await api.req('POST', '/interactions', caller.token, { ...ok, data: { id: cmd.id, options: [{ name: 'nope', type: 3, value: 'x' }] } })).status).toBe(400);
    expect((await api.req('POST', '/interactions', null, ok)).status).toBe(401);
    expect((await botReq('POST', '/interactions', botToken, ok)).status).toBe(403);
    const outsider = await api.register('out');
    expect((await api.req('POST', '/interactions', outsider.token, ok)).status).toBe(404); // cannot even see the channel

    const inv = await api.req('POST', '/interactions', caller.token, ok);
    expect(inv.status).toBe(202);
    const ev = await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === inv.body.id);
    const it = ev.d;
    expect(it.type).toBe(2); expect(it.data.name).toBe('ping'); expect(it.data.options[0].value).toBe('hello');
    expect(it.user.id).toBe(caller.id); expect(it.guildId).toBe(guild.id); expect(it.token.length).toBeGreaterThan(30);
    const [row] = await env.ctx.db.query('SELECT * FROM interactions WHERE id = $1', [it.id]);
    expect(row.token_hash).not.toBe(it.token); expect(JSON.stringify(row)).not.toContain(it.token);
    const ttl = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
    expect(ttl).toBe(15 * 60_000);

    // wrong token / wrong id -> same 404 (no oracle)
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}x/callback`, null, { type: 4, data: { content: 'x' } })).body.errorCode).toBe(ErrorCode.UNKNOWN_INTERACTION);
    expect((await api.req('POST', `/interactions/${it.id}1/${it.token}/callback`, null, { type: 4, data: { content: 'x' } })).status).toBe(404);
    // invalid bodies do not burn the acknowledgement
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, { type: 4, data: { content: 'x', flags: 1 << 3 } })).status).toBe(400);
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, { type: 99 })).status).toBe(400);
    const cb = await api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, { type: 4, data: { content: 'pong: hello' } });
    expect(cb.status).toBe(204);
    const msg = await byWs.waitEvent('MESSAGE_CREATE', (d) => d.content === 'pong: hello');
    expect(msg.d.author.id).toBe(app.botUser.id); expect(msg.d.interaction).toMatchObject({ id: it.id, name: 'ping', userId: caller.id });
    expect(msg.d.applicationId).toBe(app.id);
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, { type: 4, data: { content: 'again' } })).body.errorCode).toBe(40060);

    // ephemeral followup: only the caller gets it, and it never appears in history
    const eph = await api.req('POST', `/interactions/${it.id}/${it.token}/messages`, null, { content: 'secret', flags: 64 });
    expect(eph.status).toBe(201); expect(eph.body.flags & 64).toBe(64);
    await callerWs.waitEvent('MESSAGE_CREATE', (d) => d.content === 'secret');
    await byWs.expectNone((f) => f.t === 'MESSAGE_CREATE' && f.d.content === 'secret');
    for (const u of [caller, bystander, owner]) {
      const hist = await api.req('GET', `/channels/${general.id}/messages`, u.token);
      expect(JSON.stringify(hist.body)).not.toContain('secret');
    }
    expect(JSON.stringify((await api.req('GET', `/guilds/${guild.id}/messages/search?q=secret`, caller.token)).body)).not.toContain('secret');
    // edit original + public followup + delete
    const edit = await api.req('PATCH', `/interactions/${it.id}/${it.token}/messages/@original`, null, { content: 'pong edited' });
    expect(edit.status).toBe(200); expect(edit.body.content).toBe('pong edited');
    const fu = await api.req('POST', `/interactions/${it.id}/${it.token}/messages`, null, { content: 'follow' });
    expect(fu.status).toBe(201);
    expect((await api.req('DELETE', `/interactions/${it.id}/${it.token}/messages/${fu.body.id}`, null)).status).toBe(204);
    expect((await api.req('GET', `/interactions/${it.id}/${it.token}/messages/@original`, null)).body.content).toBe('pong edited');

    // token TTL: expire it and everything 404s
    await env.ctx.db.query(`UPDATE interactions SET expires_at = now() - interval '1 second' WHERE id = $1`, [it.id]);
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/messages`, null, { content: 'late' })).status).toBe(404);
    bot.close(); callerWs.close(); byWs.close();
  });

  it('deferred responses: placeholder is filled by the first followup; unanswered interactions fail after 3s', async () => {
    const { owner, guild, general, members } = await guildWith('caller2');
    const caller = members[0] as any;
    const { app, botToken } = await appInGuild(owner, guild);
    const cmd = (await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: 'slow', description: 's' })).body;
    const bot = await WsClient.connect(env.port); await bot.identify(`Bot ${botToken}`);
    const cw = await WsClient.connect(env.port); await cw.identify(caller.token);
    const i1 = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: cmd.id } });
    const it = (await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === i1.body.id)).d;
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/messages`, null, { content: 'too early' })).status).toBe(400);
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, { type: 5 })).status).toBe(204);
    const loading = await cw.waitEvent('MESSAGE_CREATE', (d) => d.interaction?.id === it.id);
    expect(loading.d.flags & 128).toBe(128);
    const filled = await api.req('POST', `/interactions/${it.id}/${it.token}/messages`, null, { content: 'done thinking' });
    expect(filled.body.id).toBe(loading.d.id); expect(filled.body.flags & 128).toBe(0);
    await cw.waitEvent('MESSAGE_UPDATE', (d) => d.id === loading.d.id && d.content === 'done thinking');
    // no answer within 3s -> INTERACTION_FAILED to the user, token dead
    const i2 = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: cmd.id } });
    const it2 = (await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === i2.body.id)).d;
    const failed = await cw.waitEvent('INTERACTION_FAILED', (d) => d.id === i2.body.id, 6000);
    expect(failed.d.applicationId).toBe(app.id);
    expect((await api.req('POST', `/interactions/${it2.id}/${it2.token}/callback`, null, { type: 4, data: { content: 'late' } })).status).toBe(404);
    // offline bot fails immediately
    bot.close(); await new Promise((r) => setTimeout(r, 300));
    const i3 = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: cmd.id } });
    await cw.waitEvent('INTERACTION_FAILED', (d) => d.id === i3.body.id, 4000);
    cw.close();
  });

  it('autocomplete, user/message context menus, and modals', async () => {
    const { owner, guild, general, members } = await guildWith('caller3', 'target');
    const [caller, target] = members as any[];
    const { app, botToken } = await appInGuild(owner, guild);
    const mk = async (b: object) => (await botReq('POST', `/applications/${app.id}/commands`, botToken, b)).body;
    const search = await mk({ name: 'find', description: 'f', options: [{ type: 3, name: 'q', description: 'q', autocomplete: true }, { type: 4, name: 'n', description: 'n', minValue: 1, maxValue: 5, choices: [{ name: 'one', value: 1 }, { name: 'two', value: 2 }] }] });
    const userCmd = await mk({ name: 'Inspect', type: 2 });
    const msgCmd = await mk({ name: 'Quote', type: 3 });
    const bot = await WsClient.connect(env.port); await bot.identify(`Bot ${botToken}`);
    const cw = await WsClient.connect(env.port); await cw.identify(caller.token);
    const cb = (it: any, body: object) => api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, body);
    const next = async (id: string) => (await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === id)).d;

    // choices are enforced on submit but not while autocompleting
    expect((await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: search.id, options: [{ name: 'n', type: 4, value: 3 }] } })).status).toBe(400);
    const ac = await api.req('POST', '/interactions', caller.token, { type: 4, channelId: general.id, data: { id: search.id, options: [{ name: 'q', type: 3, value: 'al', focused: true }] } });
    const acIt = await next(ac.body.id);
    expect(acIt.type).toBe(4);
    expect((await cb(acIt, { type: 8, data: { choices: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `v${i}` })) } })).status).toBe(400);
    expect((await cb(acIt, { type: 4, data: { content: 'wrong type' } })).status).toBe(400);
    expect((await cb(acIt, { type: 8, data: { choices: [{ name: 'alpha', value: 'alpha' }] } })).status).toBe(204);
    expect((await cw.waitEvent('INTERACTION_AUTOCOMPLETE_RESULT', (d) => d.interactionId === acIt.id)).d.choices[0].name).toBe('alpha');

    // user context menu
    expect((await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: userCmd.id } })).status).toBe(400); // targetId missing
    expect((await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: userCmd.id, targetId: '999' } })).status).toBe(404);
    const u = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: userCmd.id, targetId: target.id } });
    expect((await next(u.body.id)).data.resolved.users[target.id].username).toBe(target.username);
    // message context menu
    const m = (await api.req('POST', `/channels/${general.id}/messages`, target.token, { content: 'quote me' })).body;
    const mi = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: msgCmd.id, targetId: m.id } });
    expect((await next(mi.body.id)).data.resolved.messages[m.id].content).toBe('quote me');

    // modal: app opens it, user submits once, validation against the definition
    const s = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: search.id, options: [{ name: 'n', type: 4, value: 2 }] } });
    const sIt = await next(s.body.id);
    const modal = { customId: 'feedback', title: 'Feedback', components: [{ type: 1, components: [{ type: 4, customId: 'body', label: 'Text', textStyle: 1, minLength: 3, maxLength: 10 }] }] };
    expect((await cb(sIt, { type: 9, data: { ...modal, components: [{ type: 1, components: [{ type: 2, style: 1, label: 'x', customId: 'b' }] }] } })).status).toBe(400);
    expect((await cb(sIt, { type: 9, data: modal })).status).toBe(204);
    expect((await cw.waitEvent('INTERACTION_MODAL', (d) => d.interactionId === sIt.id)).d.modal.title).toBe('Feedback');
    const submit = (v: string, uid = sIt.id, tok = caller.token) => api.req('POST', '/interactions', tok, { type: 5, channelId: general.id, interactionId: uid, data: { customId: 'feedback', components: [{ type: 1, components: [{ type: 4, customId: 'body', value: v }] }] } });
    expect((await submit('x')).status).toBe(400); // too short
    expect((await submit('this is far too long')).status).toBe(400);
    expect((await submit('fine', sIt.id, target.token)).status).toBe(404); // someone else's modal
    const good = await submit('fine');
    expect(good.status).toBe(202);
    const sub = await next(good.body.id);
    expect(sub.type).toBe(5); expect(sub.data.components[0].components[0].value).toBe('fine');
    expect((await submit('fine')).status).toBe(404); // one submission per modal
    bot.close(); cw.close();
  });

  it('components: bot-only, validated, pressed by users, selects checked, ephemeral messages private, update-message', async () => {
    const { owner, guild, general, members } = await guildWith('presser', 'peeker');
    const [presser, peeker] = members as any[];
    const { app, botToken } = await appInGuild(owner, guild);
    const bot = await WsClient.connect(env.port); await bot.identify(`Bot ${botToken}`);
    const pw = await WsClient.connect(env.port); await pw.identify(presser.token);
    const comps = [
      { type: 1, components: [{ type: 2, style: 1, label: 'Go', customId: 'go' }, { type: 2, style: 5, label: 'Docs', url: 'https://example.com' }, { type: 2, style: 2, label: 'Off', customId: 'off', disabled: true }] },
      { type: 1, components: [{ type: 3, customId: 'pick', minValues: 1, maxValues: 2, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }] }] },
      { type: 1, components: [{ type: 5, customId: 'who' }] },
    ];
    // users cannot send components; invalid layouts are rejected
    expect((await api.req('POST', `/channels/${general.id}/messages`, presser.token, { content: 'hi', components: comps })).status).toBe(403);
    for (const bad of [
      [{ type: 1, components: [{ type: 2, style: 1, label: 'x' }] }],                                      // no customId
      [{ type: 1, components: [{ type: 2, style: 5, label: 'x', url: 'javascript:alert(1)' }] }],            // bad url
      [{ type: 1, components: [{ type: 2, style: 1, label: 'x', customId: 'a' }, { type: 3, customId: 's', options: [{ label: 'a', value: 'a' }] }] }],
      [{ type: 1, components: [{ type: 2, style: 1, label: 'x', customId: 'dup' }] }, { type: 1, components: [{ type: 2, style: 1, label: 'y', customId: 'dup' }] }],
      Array.from({ length: 6 }, (_, i) => ({ type: 1, components: [{ type: 2, style: 1, label: 'x', customId: `c${i}` }] })),
      [{ type: 1, components: [{ type: 4, customId: 't', label: 'text' }] }],
    ]) expect((await botReq('POST', `/channels/${general.id}/messages`, botToken, { content: 'bad', components: bad })).status, JSON.stringify(bad)).toBe(400);
    const posted = await botReq('POST', `/channels/${general.id}/messages`, botToken, { content: 'menu', components: comps });
    expect(posted.status).toBe(201); expect(posted.body.components).toHaveLength(3); expect(posted.body.applicationId).toBe(app.id);
    const press = (customId: string, values?: string[], tok = presser.token, messageId = posted.body.id) => api.req('POST', '/interactions', tok, { type: 3, channelId: general.id, messageId, data: { customId, ...(values ? { values } : {}) } });
    expect((await press('nope')).status).toBe(404);
    expect((await press('off')).status).toBe(400); // disabled
    expect((await press('go', ['x'])).status).toBe(400); // buttons take no values
    expect((await press('pick', [])).status).toBe(400); // min 1
    expect((await press('pick', ['a', 'b', 'c'])).status).toBe(400); // max 2
    expect((await press('pick', ['zzz'])).status).toBe(400); // not an option
    expect((await press('who', ['99999'])).status).toBe(400); // not a member
    expect((await press('who', [presser.id])).status).toBe(202);
    const userPick = await bot.waitEvent('INTERACTION_CREATE', (d) => d.type === 3 && d.data.customId === 'who');
    expect(userPick.d.data.values).toEqual([presser.id]);
    const p = await press('pick', ['a', 'c']);
    const it = (await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === p.body.id)).d;
    expect(it.data).toMatchObject({ customId: 'pick', componentType: 3, values: ['a', 'c'] }); expect(it.message.id).toBe(posted.body.id);
    // type 6 deferred update, then 7 update on a fresh press
    expect((await api.req('POST', `/interactions/${it.id}/${it.token}/callback`, null, { type: 6 })).status).toBe(204);
    const g = await press('go'); const git = (await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === g.body.id)).d;
    expect((await api.req('POST', `/interactions/${git.id}/${git.token}/callback`, null, { type: 7, data: { content: 'clicked', components: [] } })).status).toBe(204);
    const upd = await pw.waitEvent('MESSAGE_UPDATE', (d) => d.id === posted.body.id && d.content === 'clicked');
    expect(upd.d.components).toEqual([]); expect(upd.d.editedAt).toBeNull();
    // an ordinary user message has no components to press
    const plain = (await api.req('POST', `/channels/${general.id}/messages`, peeker.token, { content: 'plain' })).body;
    expect((await press('go', undefined, presser.token, plain.id)).status).toBe(400);
    // ephemeral message with components: only its recipient may press them
    const cmd = (await botReq('POST', `/applications/${app.id}/commands`, botToken, { name: 'eph', description: 'e' })).body;
    const ci = await api.req('POST', '/interactions', presser.token, { type: 2, channelId: general.id, data: { id: cmd.id } });
    const cit = (await bot.waitEvent('INTERACTION_CREATE', (d) => d.id === ci.body.id)).d;
    const em = await api.req('POST', `/interactions/${cit.id}/${cit.token}/callback`, null, { type: 4, data: { content: 'only you', flags: 64, components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Yes', customId: 'yes' }] }] } });
    expect(em.status).toBe(204);
    const ephMsg = (await api.req('GET', `/interactions/${cit.id}/${cit.token}/messages/@original`, null)).body;
    expect((await press('yes', undefined, peeker.token, ephMsg.id)).status).toBe(404);
    expect((await press('yes', undefined, presser.token, ephMsg.id)).status).toBe(202);
    bot.close(); pw.close();
  });

  it('only the owning bot can edit components of its messages', async () => {
    const { owner, guild, general } = await guildWith();
    const a = await appInGuild(owner, guild); const b = await appInGuild(owner, guild);
    const m = (await botReq('POST', `/channels/${general.id}/messages`, a.botToken, { content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'a', customId: 'a' }] }] })).body;
    expect((await botReq('PATCH', `/channels/${general.id}/messages/${m.id}`, b.botToken, { components: [] })).status).toBe(403);
    expect((await api.req('PATCH', `/channels/${general.id}/messages/${m.id}`, owner.token, { components: [] })).status).toBe(403);
    const ok = await botReq('PATCH', `/channels/${general.id}/messages/${m.id}`, a.botToken, { components: [] });
    expect(ok.status).toBe(200); expect(ok.body.components).toEqual([]);
  });
});

describe('interactions over HTTP (Ed25519)', () => {
  it('verifies the endpoint with a signed PING, signs deliveries, and accepts the HTTP response as the callback', async () => {
    const { owner, guild, general, members } = await guildWith('httpcaller');
    const caller = members[0] as any;
    const { app, botToken } = await appInGuild(owner, guild);
    const seen: { sig: string; ts: string; body: string }[] = [];
    let mode: 'ok' | 'badpong' = 'ok';
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const sig = String(req.headers['x-signature-ed25519']), ts = String(req.headers['x-signature-timestamp']);
        seen.push({ sig, ts, body });
        if (!verifyInteractionSignature(app.publicKey, ts, body, sig)) { res.writeHead(401).end(); return; }
        const j = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        if (j.type === 1) return void res.end(JSON.stringify({ type: mode === 'ok' ? 1 : 5 }));
        res.end(JSON.stringify({ type: 4, data: { content: `http says ${j.data.options[0].value}` } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/interactions`;
    try {
      mode = 'badpong';
      expect((await api.req('PATCH', `/applications/${app.id}`, owner.token, { interactionsEndpointUrl: url })).status).toBe(400);
      mode = 'ok';
      expect((await api.req('PATCH', `/applications/${app.id}`, owner.token, { interactionsEndpointUrl: 'ftp://x.example/' })).status).toBe(400);
      const patched = await api.req('PATCH', `/applications/${app.id}`, owner.token, { interactionsEndpointUrl: url });
      expect(patched.status).toBe(200); expect(patched.body.interactionsEndpointUrl).toBe(url);
      expect(verifyInteractionSignature(app.publicKey, seen[0]!.ts, seen[0]!.body, seen[0]!.sig)).toBe(true);
      expect(verifyInteractionSignature(app.publicKey, seen[0]!.ts, seen[0]!.body + ' ', seen[0]!.sig)).toBe(false); // tamper
      const cmd = (await botReq('POST', `/applications/${app.id}/commands`, botToken, slash)).body;
      const cw = await WsClient.connect(env.port); await cw.identify(caller.token);
      const inv = await api.req('POST', '/interactions', caller.token, { type: 2, channelId: general.id, data: { id: cmd.id, options: [{ name: 'text', type: 3, value: 'yo' }] } });
      const m = await cw.waitEvent('MESSAGE_CREATE', (d) => d.content === 'http says yo');
      expect(m.d.interaction.id).toBe(inv.body.id);
      const last = seen[seen.length - 1]!;
      expect(verifyInteractionSignature(app.publicKey, last.ts, last.body, last.sig)).toBe(true);
      expect(JSON.parse(last.body).token).toBeTruthy();
      cw.close();
    } finally { srv.close(); }
  });

  it('blocks private-network endpoints when private targets are not allowed', async () => {
    const strict = await startServer({ allowPrivateUnfurl: false });
    try {
      const a = new Api(strict); const u = await a.register('ssrf');
      const app = (await a.req('POST', '/applications', u.token, { name: 'S' })).body;
      for (const url of ['http://127.0.0.1:8080/x', 'http://localhost:8080/x', 'http://169.254.169.254/latest']) expect((await a.req('PATCH', `/applications/${app.id}`, u.token, { interactionsEndpointUrl: url })).status).toBe(400);
    } finally { await strict.close(); }
  });
});

describe('polls', () => {
  const poll = { question: 'Lunch?', answers: [{ text: 'Pizza' }, { text: 'Sushi', emoji: '🍣' }, { text: 'Tacos' }], durationHours: 24 };
  it('creates, votes (single/multi), lists voters, ends early and posts the result', async () => {
    const { owner, guild, general, members } = await guildWith('v1', 'v2');
    const [v1, v2] = members as any[];
    const ws = await WsClient.connect(env.port); await ws.identify(v2.token);
    for (const bad of [
      { ...poll, question: '' }, { ...poll, answers: [] }, { ...poll, answers: Array.from({ length: 11 }, (_, i) => ({ text: `a${i}` })) },
      { ...poll, answers: [{ text: 'x'.repeat(56) }] }, { ...poll, durationHours: 769 }, { ...poll, durationHours: 0 }, { ...poll, extra: 1 },
    ]) expect((await api.req('POST', `/channels/${general.id}/messages`, v1.token, { poll: bad })).status).toBe(400);
    const m = await api.req('POST', `/channels/${general.id}/messages`, v1.token, { poll });
    expect(m.status).toBe(201);
    expect(m.body.poll.answers.map((a: any) => [a.id, a.text, a.count])).toEqual([[1, 'Pizza', 0], [2, 'Sushi', 0], [3, 'Tacos', 0]]);
    expect(m.body.poll.isFinalized).toBe(false);
    const vote = (u: any, ids: number[]) => api.req('PUT', `/channels/${general.id}/polls/${m.body.id}/votes`, u.token, { answerIds: ids });
    expect((await vote(v2, [9])).status).toBe(400);
    expect((await vote(v2, [1, 2])).status).toBe(400); // single-choice
    const r = await vote(v2, [2]);
    expect(r.status).toBe(200); expect(r.body.poll.answers[1]).toMatchObject({ count: 1, meVoted: true });
    await ws.waitEvent('MESSAGE_POLL_VOTE_ADD', (d) => d.answerId === 2 && d.userId === v2.id);
    await vote(v2, [3]); // changing a vote removes the old one
    await ws.waitEvent('MESSAGE_POLL_VOTE_REMOVE', (d) => d.answerId === 2);
    await vote(v1, [3]);
    const view = (await api.req('GET', `/channels/${general.id}/messages`, v2.token)).body.find((x: any) => x.id === m.body.id);
    expect(view.poll.answers.map((a: any) => a.count)).toEqual([0, 0, 2]); expect(view.poll.answers[2].meVoted).toBe(true); expect(view.poll.totalVotes).toBe(2);
    const owner_view = (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body.find((x: any) => x.id === m.body.id);
    expect(owner_view.poll.answers[2].meVoted).toBe(false);
    const voters = await api.req('GET', `/channels/${general.id}/polls/${m.body.id}/answers/3`, owner.token);
    expect(voters.body.users.map((u: any) => u.id).sort()).toEqual([v1.id, v2.id].sort());
    expect((await api.req('GET', `/channels/${general.id}/polls/${m.body.id}/answers/9`, owner.token)).status).toBe(404);
    expect((await api.req('DELETE', `/channels/${general.id}/polls/${m.body.id}/votes/@me`, v2.token)).status).toBe(200);
    // ending early: author or MANAGE_MESSAGES only
    const stranger = await api.register('stranger');
    expect((await api.req('POST', `/channels/${general.id}/polls/${m.body.id}/expire`, stranger.token)).status).toBe(404);
    expect((await api.req('POST', `/channels/${general.id}/polls/${m.body.id}/expire`, v2.token)).status).toBe(403);
    const end = await api.req('POST', `/channels/${general.id}/polls/${m.body.id}/expire`, v1.token);
    expect(end.status).toBe(200); expect(end.body.poll.isFinalized).toBe(true);
    const result = await ws.waitEvent('MESSAGE_CREATE', (d) => d.type === 'poll_result');
    expect(result.d.replyTo).toBe(m.body.id); expect(result.d.content).toContain('Tacos');
    const blocked = await vote(v2, [1]);
    expect(blocked.status).toBe(400); expect(blocked.body.errorCode).toBe(520000);
    expect((await api.req('POST', `/channels/${general.id}/polls/${m.body.id}/expire`, v1.token)).status).toBe(400);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?action=POLL_END`, owner.token)).body.length).toBe(1);
    ws.close();
  });

  it('multiselect polls, concurrent votes stay consistent, expiry via the sweeper finalizes exactly once', async () => {
    const { general, members } = await guildWith('mv');
    const v = members[0] as any;
    const m = (await api.req('POST', `/channels/${general.id}/messages`, v.token, { poll: { ...poll, allowMultiselect: true, durationHours: 1 } })).body;
    const r = await api.req('PUT', `/channels/${general.id}/polls/${m.id}/votes`, v.token, { answerIds: [1, 3] });
    expect(r.body.poll.answers.map((a: any) => a.count)).toEqual([1, 0, 1]);
    const single = (await api.req('POST', `/channels/${general.id}/messages`, v.token, { poll })).body;
    const results = await Promise.all([1, 2, 3].map((a) => api.req('PUT', `/channels/${general.id}/polls/${single.id}/votes`, v.token, { answerIds: [a] })));
    expect(results.every((x) => x.status === 200)).toBe(true);
    expect((await env.ctx.db.query('SELECT count(*)::int AS n FROM poll_votes WHERE message_id = $1', [single.id]))[0].n).toBe(1);
    await env.ctx.db.query(`UPDATE messages SET poll_expiry = now() - interval '1 minute' WHERE id = $1`, [m.id]);
    const fresh = (await api.req('GET', `/channels/${general.id}/messages`, v.token)).body.find((x: any) => x.id === m.id);
    expect(fresh.poll.isFinalized).toBe(true); // visible before the sweeper runs
    expect((await api.req('PUT', `/channels/${general.id}/polls/${m.id}/votes`, v.token, { answerIds: [2] })).status).toBe(400);
    await runSweeps(env.ctx); await runSweeps(env.ctx);
    const msgs = (await api.req('GET', `/channels/${general.id}/messages`, v.token)).body;
    expect(msgs.filter((x: any) => x.type === 'poll_result' && x.replyTo === m.id)).toHaveLength(1);
  });

  it('SEND_POLLS is required in guild channels (role and overwrite aware); votes need channel access', async () => {
    const { owner, guild, general, members } = await guildWith('nopoll', 'voter');
    const [nopoll, voter] = members as any[];
    await api.req('PATCH', `/guilds/${guild.id}/roles/${guild.id}`, owner.token, { permissions: (DEFAULT_EVERYONE & ~Perm.SEND_POLLS).toString() });
    const denied = await api.req('POST', `/channels/${general.id}/messages`, nopoll.token, { poll });
    expect(denied.status).toBe(403);
    expect((await api.req('POST', `/channels/${general.id}/messages`, nopoll.token, { content: 'plain still works' })).status).toBe(201);
    await api.req('PUT', `/channels/${general.id}/permissions/${nopoll.id}`, owner.token, { type: 'member', allow: Perm.SEND_POLLS.toString(), deny: '0' });
    const m = await api.req('POST', `/channels/${general.id}/messages`, nopoll.token, { poll });
    expect(m.status).toBe(201);
    // hide the channel from voter: cannot vote or list
    await api.req('PUT', `/channels/${general.id}/permissions/${voter.id}`, owner.token, { type: 'member', allow: '0', deny: Perm.VIEW_CHANNEL.toString() });
    expect((await api.req('PUT', `/channels/${general.id}/polls/${m.body.id}/votes`, voter.token, { answerIds: [1] })).status).toBe(404);
    // a poll id from another channel is not reachable through this one
    const other = guild.channels.find((c: any) => c.name === 'General');
    expect((await api.req('PUT', `/channels/${other.id}/polls/${m.body.id}/votes`, owner.token, { answerIds: [1] })).status).toBe(404);
  });
});

describe('voice-channel text chat', () => {
  it('voice and stage channels accept messages under SEND_MESSAGES, overwrites included', async () => {
    const { owner, guild, voice, members } = await guildWith('chatter');
    const c = members[0] as any;
    expect(voice.type).toBe('voice');
    expect((await api.req('POST', `/channels/${voice.id}/messages`, c.token, { content: 'hello from voice chat' })).status).toBe(201);
    expect((await api.req('GET', `/channels/${voice.id}/messages`, c.token)).body[0].content).toBe('hello from voice chat');
    await api.req('PUT', `/channels/${voice.id}/permissions/${c.id}`, owner.token, { type: 'member', allow: '0', deny: Perm.SEND_MESSAGES.toString() });
    expect((await api.req('POST', `/channels/${voice.id}/messages`, c.token, { content: 'blocked' })).status).toBe(403);
    expect((await api.req('GET', `/channels/${voice.id}/messages`, c.token)).status).toBe(200); // can still read
    const stage = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'st', type: 'stage' })).body;
    expect((await api.req('POST', `/channels/${stage.id}/messages`, owner.token, { content: 'stage chat' })).status).toBe(201);
  });
});

describe('scheduled events', () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  it('CRUD with Discord-style permission rules per entity type', async () => {
    const { owner, guild, voice, members } = await guildWith('creator', 'bystander');
    const [creator, by] = members as any[];
    const ext = { name: 'Meetup', entityType: 3, scheduledStartTime: inHours(2), scheduledEndTime: inHours(3), location: 'Town hall' };
    expect((await api.req('POST', `/guilds/${guild.id}/scheduled-events`, creator.token, ext)).status).toBe(403); // CREATE_EVENTS not in @everyone
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'events', permissions: Perm.CREATE_EVENTS.toString() })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${creator.id}`, owner.token, { roles: [role.id] });
    const ws = await WsClient.connect(env.port); await ws.identify(by.token);
    for (const bad of [
      { ...ext, scheduledStartTime: inHours(-1) }, { ...ext, scheduledEndTime: inHours(1) }, { ...ext, location: undefined }, { ...ext, scheduledEndTime: undefined },
      { ...ext, channelId: voice.id }, { name: 'v', entityType: 2, scheduledStartTime: inHours(1) }, { name: 'v', entityType: 2, channelId: guild.channels.find((c: any) => c.name === 'general').id, scheduledStartTime: inHours(1) },
    ]) expect((await api.req('POST', `/guilds/${guild.id}/scheduled-events`, creator.token, bad)).status, JSON.stringify(bad)).toBe(400);
    const e = await api.req('POST', `/guilds/${guild.id}/scheduled-events`, creator.token, ext);
    expect(e.status).toBe(201); expect(e.body).toMatchObject({ status: 1, entityType: 3, userCount: 0, creatorId: creator.id });
    await ws.waitEvent('GUILD_SCHEDULED_EVENT_CREATE', (d) => d.id === e.body.id);
    // voice event: needs VIEW_CHANNEL+CONNECT in the channel
    const vEvent = { name: 'Voice party', entityType: 2, channelId: voice.id, scheduledStartTime: inHours(5) };
    await api.req('PUT', `/channels/${voice.id}/permissions/${creator.id}`, owner.token, { type: 'member', allow: '0', deny: Perm.CONNECT.toString() });
    expect((await api.req('POST', `/guilds/${guild.id}/scheduled-events`, creator.token, vEvent)).status).toBe(403);
    await api.req('DELETE', `/channels/${voice.id}/permissions/${creator.id}`, owner.token);
    const ve = await api.req('POST', `/guilds/${guild.id}/scheduled-events`, creator.token, vEvent);
    expect(ve.status).toBe(201);
    // stage event additionally needs MANAGE_CHANNELS+MUTE+MOVE
    const stage = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'st', type: 'stage' })).body;
    expect((await api.req('POST', `/guilds/${guild.id}/scheduled-events`, creator.token, { name: 's', entityType: 1, channelId: stage.id, scheduledStartTime: inHours(1) })).status).toBe(403);
    expect((await api.req('POST', `/guilds/${guild.id}/scheduled-events`, owner.token, { name: 's', entityType: 1, channelId: stage.id, scheduledStartTime: inHours(1) })).status).toBe(201);
    // hiding the voice channel hides its event
    await api.req('PUT', `/channels/${voice.id}/permissions/${by.id}`, owner.token, { type: 'member', allow: '0', deny: Perm.VIEW_CHANNEL.toString() });
    const list = (await api.req('GET', `/guilds/${guild.id}/scheduled-events`, by.token)).body;
    expect(list.map((x: any) => x.name).sort()).toEqual(['Meetup', 's']);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events/${ve.body.id}`, by.token)).status).toBe(404);
    // modify/delete: creator may, bystander may not; MANAGE_EVENTS can
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.body.id}`, by.token, { name: 'hijack' })).status).toBe(403);
    const upd = await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.body.id}`, creator.token, { name: 'Meetup 2', description: 'bring snacks' });
    expect(upd.body).toMatchObject({ name: 'Meetup 2', description: 'bring snacks' });
    await ws.waitEvent('GUILD_SCHEDULED_EVENT_UPDATE', (d) => d.name === 'Meetup 2');
    expect((await api.req('DELETE', `/guilds/${guild.id}/scheduled-events/${e.body.id}`, by.token)).status).toBe(403);
    expect((await api.req('DELETE', `/guilds/${guild.id}/scheduled-events/${e.body.id}`, creator.token)).status).toBe(204);
    await ws.waitEvent('GUILD_SCHEDULED_EVENT_DELETE', (d) => d.id === e.body.id);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events/${e.body.id}`, creator.token)).status).toBe(404);
    const log = (await api.req('GET', `/guilds/${guild.id}/audit-logs?actionType=100`, owner.token)).body;
    expect(log.length).toBeGreaterThanOrEqual(2);
    const outsider = await api.register('out2');
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events`, outsider.token)).status).toBe(404);
    ws.close();
  });

  it('status lifecycle: manual and time-driven, terminal states are immutable, interested users', async () => {
    const { owner, guild, members } = await guildWith('fan');
    const fan = members[0] as any;
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    const mk = async (extra = {}) => (await api.req('POST', `/guilds/${guild.id}/scheduled-events`, owner.token, { name: 'E', entityType: 3, scheduledStartTime: inHours(1), scheduledEndTime: inHours(2), location: 'x', ...extra })).body;
    const e = await mk();
    // interest
    expect((await api.req('PUT', `/guilds/${guild.id}/scheduled-events/${e.id}/users/@me`, fan.token)).status).toBe(204);
    await ws.waitEvent('GUILD_SCHEDULED_EVENT_USER_ADD', (d) => d.userId === fan.id);
    expect((await api.req('PUT', `/guilds/${guild.id}/scheduled-events/${e.id}/users/@me`, fan.token)).status).toBe(204); // idempotent
    const users = (await api.req('GET', `/guilds/${guild.id}/scheduled-events/${e.id}/users`, owner.token)).body;
    expect(users.map((u: any) => u.user.id)).toEqual([fan.id]);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events/${e.id}`, fan.token)).body).toMatchObject({ userCount: 1, interested: true });
    // illegal transitions
    for (const status of [3, 1 + 4]) expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { status })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { status: 2 })).body.status).toBe(2);
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { status: 4 })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { scheduledStartTime: inHours(9) })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { status: 3 })).body.status).toBe(3);
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { name: 'late edit' })).status).toBe(400);
    expect((await api.req('PUT', `/guilds/${guild.id}/scheduled-events/${e.id}/users/@me`, fan.token)).status).toBe(409);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events`, owner.token)).body.some((x: any) => x.id === e.id)).toBe(false); // finished events leave the upcoming list
    // cancel from scheduled
    const c = await mk();
    expect((await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${c.id}`, owner.token, { status: 4 })).body.status).toBe(4);
    // time-driven: start then end
    const t = await mk();
    await env.ctx.db.query(`UPDATE guild_scheduled_events SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    await runSweeps(env.ctx);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events/${t.id}`, owner.token)).body.status).toBe(2);
    await ws.waitEvent('GUILD_SCHEDULED_EVENT_UPDATE', (d) => d.id === t.id && d.status === 2);
    await env.ctx.db.query(`UPDATE guild_scheduled_events SET scheduled_end = now() - interval '1 second' WHERE id = $1`, [t.id]);
    await runSweeps(env.ctx);
    expect((await api.req('GET', `/guilds/${guild.id}/scheduled-events/${t.id}`, owner.token)).body.status).toBe(3);
    ws.close();
  });

  it('a stage event opens a stage instance when it starts and closes it when it ends', async () => {
    const { owner, guild } = await guildWith();
    const stage = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'live', type: 'stage' })).body;
    const e = (await api.req('POST', `/guilds/${guild.id}/scheduled-events`, owner.token, { name: 'AMA', entityType: 1, channelId: stage.id, scheduledStartTime: inHours(1) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { status: 2 });
    const si = await api.req('GET', `/stage-instances/${stage.id}`, owner.token);
    expect(si.body).toMatchObject({ topic: 'AMA', scheduledEventId: e.id });
    await api.req('PATCH', `/guilds/${guild.id}/scheduled-events/${e.id}`, owner.token, { status: 3 });
    expect((await api.req('GET', `/stage-instances/${stage.id}`, owner.token)).status).toBe(404);
  });
});

describe('stage instances', () => {
  it('requires stage moderator permissions; topic lifecycle and events', async () => {
    const { owner, guild, general, members } = await guildWith('spk');
    const spk = members[0] as any;
    const stage = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'talk', type: 'stage' })).body;
    const ws = await WsClient.connect(env.port); await ws.identify(spk.token);
    expect((await api.req('POST', '/stage-instances', spk.token, { channelId: stage.id, topic: 'nope' })).status).toBe(403);
    expect((await api.req('POST', '/stage-instances', owner.token, { channelId: general.id, topic: 'text channel' })).status).toBe(404);
    expect((await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: '' })).status).toBe(400);
    expect((await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: 'x'.repeat(121) })).status).toBe(400);
    const c = await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: 'Q&A' });
    expect(c.status).toBe(201);
    await ws.waitEvent('STAGE_INSTANCE_CREATE', (d) => d.topic === 'Q&A');
    expect((await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: 'dup' })).status).toBe(409);
    expect((await api.req('GET', `/stage-instances/${stage.id}`, spk.token)).body.topic).toBe('Q&A');
    expect((await api.req('GET', `/guilds/${guild.id}/stage-instances`, spk.token)).body).toHaveLength(1);
    expect((await api.req('PATCH', `/stage-instances/${stage.id}`, spk.token, { topic: 'x' })).status).toBe(403);
    expect((await api.req('PATCH', `/stage-instances/${stage.id}`, owner.token, { topic: 'New topic' })).body.topic).toBe('New topic');
    await ws.waitEvent('STAGE_INSTANCE_UPDATE', (d) => d.topic === 'New topic');
    expect((await api.req('DELETE', `/stage-instances/${stage.id}`, spk.token)).status).toBe(403);
    expect((await api.req('DELETE', `/stage-instances/${stage.id}`, owner.token)).status).toBe(204);
    await ws.waitEvent('STAGE_INSTANCE_DELETE', (d) => d.channelId === stage.id);
    expect((await api.req('DELETE', `/stage-instances/${stage.id}`, owner.token)).status).toBe(404);
    // empty stages are cleaned up by the sweeper after a grace period
    await api.req('POST', '/stage-instances', owner.token, { channelId: stage.id, topic: 'ghost' });
    await runSweeps(env.ctx);
    expect((await api.req('GET', `/stage-instances/${stage.id}`, owner.token)).status).toBe(200); // still within the grace period
    await env.ctx.db.query(`UPDATE stage_instances SET created_at = now() - interval '5 minutes'`);
    await runSweeps(env.ctx);
    expect((await api.req('GET', `/stage-instances/${stage.id}`, owner.token)).status).toBe(404);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?actionType=85`, owner.token)).body.length).toBeGreaterThan(0);
    ws.close();
  });
});

describe('forum tags and thread lifecycle', () => {
  it('tag catalogue, applied tags, moderated + required tags', async () => {
    const { owner, guild, members } = await guildWith('poster');
    const poster = members[0] as any;
    const forum = guild.channels.find((c: any) => c.type === 'forum') ?? (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'forum', type: 'forum' })).body;
    const patched = await api.req('PATCH', `/channels/${forum.id}`, owner.token, { availableTags: [{ name: 'bug' }, { name: 'idea', emoji: '💡' }, { name: 'staff', moderated: true }], requireTag: true });
    expect(patched.status).toBe(200);
    const tags = patched.body.availableTags; expect(tags).toHaveLength(3); expect(tags[0].id).toBeTruthy(); expect(patched.body.requireTag).toBe(true);
    expect((await api.req('PATCH', `/channels/${forum.id}`, poster.token, { requireTag: false })).status).toBe(403);
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { availableTags: [{ name: 'a' }, { name: 'A' }] })).status).toBe(400);
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { availableTags: [{ id: '123', name: 'ghost' }] })).status).toBe(400);
    const post = (b: object, u = poster) => api.req('POST', `/channels/${forum.id}/forum/posts`, u.token, { name: 'p', content: 'c', ...b });
    expect((await post({})).status).toBe(400); // tag required
    expect((await post({ appliedTags: ['999'] })).status).toBe(400);
    expect((await post({ appliedTags: [tags[2].id] })).status).toBe(403); // moderated
    const ok = await post({ appliedTags: [tags[0].id] });
    expect(ok.status).toBe(201); expect(ok.body.channel.appliedTags).toEqual([tags[0].id]);
    expect((await post({ appliedTags: [tags[2].id] }, owner as any)).status).toBe(201);
    // retag own post (non-moderated only), removing a tag from the catalogue strips it from posts
    const t = ok.body.channel;
    expect((await api.req('PATCH', `/channels/${t.id}`, poster.token, { appliedTags: [tags[1].id] })).body.appliedTags).toEqual([tags[1].id]);
    expect((await api.req('PATCH', `/channels/${t.id}`, poster.token, { appliedTags: [tags[2].id] })).status).toBe(403);
    await api.req('PATCH', `/channels/${forum.id}`, owner.token, { availableTags: [tags[0]] });
    expect((await api.req('GET', `/channels/${t.id}`, poster.token)).body.appliedTags).toEqual([]);
  });

  it('threads auto-archive after idle time, restart on activity, honour locked and durations', async () => {
    const { owner, guild, general, members } = await guildWith('talker');
    const talker = members[0] as any;
    const m = (await api.req('POST', `/channels/${general.id}/messages`, talker.token, { content: 'start' })).body;
    expect((await api.req('POST', `/channels/${general.id}/messages/${m.id}/threads`, talker.token, { name: 'bad', autoArchiveDuration: 5 })).status).toBe(400);
    const th = (await api.req('POST', `/channels/${general.id}/messages/${m.id}/threads`, talker.token, { name: 't', autoArchiveDuration: 60 })).body;
    expect(th.autoArchiveDuration).toBe(60); expect(th.locked).toBe(false); expect(th.archiveAt).toBeTruthy();
    const ws = await WsClient.connect(env.port); await ws.identify(talker.token);
    await runSweeps(env.ctx);
    expect((await api.req('GET', `/channels/${th.id}`, talker.token)).body.archived).toBe(false);
    await env.ctx.db.query(`UPDATE channels SET activity_at = now() - interval '61 minutes' WHERE id = $1`, [th.id]);
    await runSweeps(env.ctx);
    const up = await ws.waitEvent('THREAD_UPDATE', (d) => d.id === th.id && d.archived === true);
    expect(up.d.archiveAt).toBeNull();
    // posting un-archives and restarts the clock
    expect((await api.req('POST', `/channels/${th.id}/messages`, talker.token, { content: 'back' })).status).toBe(201);
    const back = (await api.req('GET', `/channels/${th.id}`, talker.token)).body;
    expect(back.archived).toBe(false);
    // locked: only MANAGE_THREADS may unarchive/post into an archived thread
    expect((await api.req('PATCH', `/channels/${th.id}`, talker.token, { locked: true })).status).toBe(403);
    expect((await api.req('PATCH', `/channels/${th.id}`, owner.token, { locked: true, autoArchiveDuration: 1440 })).body).toMatchObject({ locked: true, autoArchiveDuration: 1440 });
    await api.req('PATCH', `/channels/${th.id}`, owner.token, { archived: true });
    expect((await api.req('POST', `/channels/${th.id}/messages`, talker.token, { content: 'nope' })).status).toBe(403);
    expect((await api.req('PATCH', `/channels/${th.id}`, talker.token, { archived: false })).status).toBe(403);
    expect((await api.req('PATCH', `/channels/${th.id}`, owner.token, { archived: false })).body.archived).toBe(false);
    // deleting a thread audits THREAD_DELETE and emits THREAD_DELETE
    expect((await api.req('DELETE', `/channels/${th.id}`, owner.token)).status).toBe(204);
    await ws.waitEvent('THREAD_DELETE', (d) => d.id === th.id);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?actionType=112`, owner.token)).body.length).toBe(1);
    ws.close();
  });
});

describe('audit log expansion', () => {
  it('records message delete/pin, nick changes and sticker updates with numeric action types', async () => {
    const { owner, guild, general, members } = await guildWith('subject');
    const s = members[0] as any;
    const m = (await api.req('POST', `/channels/${general.id}/messages`, s.token, { content: 'moderate me' })).body;
    await api.req('PUT', `/channels/${general.id}/pins/${m.id}`, owner.token);
    await api.req('DELETE', `/channels/${general.id}/pins/${m.id}`, owner.token);
    await api.req('DELETE', `/channels/${general.id}/messages/${m.id}`, owner.token);
    await api.req('PATCH', `/guilds/${guild.id}/members/${s.id}`, owner.token, { nick: 'newnick' });
    // webhook rename and sticker rename audit WEBHOOK_UPDATE and STICKER_UPDATE
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'Hooks' })).body;
    expect((await api.req('PATCH', `/webhooks/${hook.id}`, owner.token, { name: 'Renamed' })).status).toBe(200);
    expect((await api.req('PATCH', `/webhooks/${hook.id}`, owner.token, { name: 'Renamed' })).body).toMatchObject({ name: 'Renamed' });
    const sticker = (await api.req('POST', `/guilds/${guild.id}/stickers`, owner.token, { name: 'wave', url: '/files/x/wave.png' })).body;
    expect((await api.req('PATCH', `/guilds/${guild.id}/stickers/${sticker.id}`, owner.token, { name: 'waved' })).body).toMatchObject({ name: 'waved' });
    const log = (await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token)).body;
    const by = Object.fromEntries(log.map((e: any) => [e.action, e.actionType]));
    expect(by).toMatchObject({ MESSAGE_PIN: 74, MESSAGE_UNPIN: 75, MESSAGE_DELETE: 72, MEMBER_UPDATE: 24, WEBHOOK_UPDATE: 51, STICKER_UPDATE: 91 });
    for (const e of log) if (AuditActionType[e.action as keyof typeof AuditActionType] !== undefined) expect(e.actionType).toBe(AuditActionType[e.action as keyof typeof AuditActionType]);
    // self-delete is not a moderation action
    const m2 = (await api.req('POST', `/channels/${general.id}/messages`, s.token, { content: 'mine' })).body;
    await api.req('DELETE', `/channels/${general.id}/messages/${m2.id}`, s.token);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?actionType=72`, owner.token)).body).toHaveLength(1);
  });
});

describe('rate limits and numeric error codes', () => {
  it('emits X-RateLimit-* headers per route bucket, a Discord-shaped 429 and keeps the string code', async () => {
    const rl = await startServer({ rateLimit: true });
    try {
      const a = new Api(rl); const u = await a.register('rl');
      const g = (await a.req('POST', '/guilds', u.token, { name: 'RL' })).body;
      const r = await a.req('GET', `/guilds/${g.id}`, u.token);
      const h = r.raw.headers;
      expect(h['x-ratelimit-limit']).toBe('120'); expect(h['x-ratelimit-remaining']).toBe('119');
      expect(Number(h['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000); expect(Number(h['x-ratelimit-reset-after'])).toBeGreaterThan(0);
      expect(h['x-ratelimit-bucket']).toMatch(/^[0-9a-f]{16}$/);
      const r2 = await a.req('GET', `/guilds/${g.id}`, u.token);
      expect(r2.raw.headers['x-ratelimit-remaining']).toBe('118');
      expect(r2.raw.headers['x-ratelimit-bucket']).toBe(h['x-ratelimit-bucket']);
      expect((await a.req('GET', `/guilds/${g.id}/roles`, u.token)).raw.headers['x-ratelimit-bucket']).not.toBe(h['x-ratelimit-bucket']); // distinct routes, distinct buckets
      // exhaust the message bucket (10 / 10s)
      const ch = g.channels.find((c: any) => c.name === 'general').id;
      let last: any;
      for (let i = 0; i < 11; i++) last = await a.req('POST', `/channels/${ch}/messages`, u.token, { content: `m${i}` });
      expect(last.status).toBe(429);
      expect(last.body).toMatchObject({ code: 'RATE_LIMITED', global: false });
      expect(last.body.retry_after).toBeGreaterThan(0); expect(last.body.details.retryAfter).toBeGreaterThan(0);
      expect(last.raw.headers['retry-after']).toBeTruthy(); expect(last.raw.headers['x-ratelimit-scope']).toBe('user'); expect(last.raw.headers['x-ratelimit-remaining']).toBe('0');
      // limits are per credential, not shared
      const other = await a.register('rl2');
      expect((await a.req('GET', '/users/@me', other.token)).raw.headers['x-ratelimit-remaining']).toBe('119');
    } finally { await rl.close(); }
  });

  it('adds numeric errorCode and field errors without changing existing string codes', async () => {
    const u = await api.register('err');
    const nf = await api.req('GET', '/channels/123456789', u.token);
    expect(nf.status).toBe(404); expect(nf.body).toMatchObject({ code: 'NOT_FOUND', errorCode: ErrorCode.UNKNOWN_CHANNEL });
    expect((await api.req('GET', '/guilds/123456789', u.token)).body.errorCode).toBe(10004);
    expect((await api.req('GET', '/users/@me', null)).body).toMatchObject({ code: 'UNAUTHORIZED', errorCode: 40001 });
    const g = (await api.req('POST', '/guilds', u.token, { name: 'Err Guild' })).body;
    const v = await api.req('PATCH', `/channels/${g.channels[0].id}`, u.token, { name: '', bogus: 1 });
    expect(v.body.code).toBe('VALIDATION_ERROR'); expect(v.body.errorCode).toBe(50035); expect(Object.keys(v.body.errors).length).toBeGreaterThan(0);
    expect(Object.values(v.body.errors)[0]).toHaveProperty('_errors');
    const stranger = await api.register('err2');
    expect((await api.req('PATCH', `/guilds/${g.id}`, stranger.token, { name: 'Valid name' })).body.errorCode).toBe(10004); // not a member: still "unknown guild", no existence leak
  });
});

describe('discovery join, screening, stickers event, themes, status expiry', () => {
  it('joins discoverable guilds only; honours bans; screened joiners are pending (read-only) until they accept', async () => {
    const { owner, guild, general } = await guildWith();
    const joiner = await api.register('disc');
    expect((await api.req('POST', `/discover/guilds/${guild.id}/join`, joiner.token)).status).toBe(404); // not discoverable
    const rules = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'rules', type: 'text' })).body;
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { memberScreening: true })).status).toBe(400); // needs rules channel
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { discoverable: true, rulesChannelId: rules.id, memberScreening: true })).body.features).toEqual(expect.arrayContaining(['DISCOVERABLE', 'MEMBER_SCREENING']));
    const banned = await api.register('banned');
    await api.req('PUT', `/guilds/${guild.id}/bans/${banned.id}`, owner.token, {});
    expect((await api.req('POST', `/discover/guilds/${guild.id}/join`, banned.token)).status).toBe(403);
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    const j = await api.req('POST', `/discover/guilds/${guild.id}/join`, joiner.token);
    expect(j.status).toBe(200); expect(j.body.id).toBe(guild.id);
    expect(j.body.members.find((m: any) => m.user.id === joiner.id).pending).toBe(true);
    await ws.waitEvent('MEMBER_ADD', (d) => d.user.id === joiner.id && d.pending === true);
    expect((await api.req('POST', `/channels/${general.id}/messages`, joiner.token, { content: 'let me in' })).status).toBe(403);
    expect((await api.req('GET', `/channels/${general.id}/messages`, joiner.token)).status).toBe(200); // can read
    expect((await api.req('GET', `/guilds/${guild.id}/screening`, joiner.token)).body).toMatchObject({ enabled: true, pending: true, rulesChannelId: rules.id });
    expect((await api.req('PUT', `/guilds/${guild.id}/members/@me/screening`, joiner.token, { acceptRules: false })).status).toBe(400);
    const acc = await api.req('PUT', `/guilds/${guild.id}/members/@me/screening`, joiner.token, { acceptRules: true });
    expect(acc.body.pending).toBe(false);
    await ws.waitEvent('MEMBER_UPDATE', (d) => d.user.id === joiner.id && d.pending === false);
    expect((await api.req('POST', `/channels/${general.id}/messages`, joiner.token, { content: 'hello' })).status).toBe(201);
    // outsiders cannot accept on someone else's behalf / non-members get 404
    expect((await api.req('PUT', `/guilds/${guild.id}/members/@me/screening`, (await api.register('nm')).token, { acceptRules: true })).status).toBe(404);
    // turning screening off: new joiners are not pending
    await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { memberScreening: false });
    const j2 = await api.req('POST', `/guilds/${guild.id}/join`, (await api.register('free')).token);
    expect(j2.body.members.some((m: any) => m.pending)).toBe(false);
    ws.close();
  });

  it('emits STICKERS_UPDATE on create, rename and delete', async () => {
    const { owner, guild } = await guildWith();
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    const s = (await api.req('POST', `/guilds/${guild.id}/stickers`, owner.token, { name: 'wave', url: '/files/x/wave.png' })).body;
    expect((await ws.waitEvent('STICKERS_UPDATE', (d) => d.stickers.length === 1)).d.guildId).toBe(guild.id);
    await api.req('PATCH', `/guilds/${guild.id}/stickers/${s.id}`, owner.token, { name: 'waved' });
    await ws.waitEvent('STICKERS_UPDATE', (d) => d.stickers[0]?.name === 'waved');
    await api.req('DELETE', `/guilds/${guild.id}/stickers/${s.id}`, owner.token);
    await ws.waitEvent('STICKERS_UPDATE', (d) => d.stickers.length === 0);
    ws.close();
  });

  it('two-colour themes are public and validated', async () => {
    const { owner, members } = await guildWith('peer');
    const peer = members[0] as any;
    expect((await api.req('PATCH', '/users/@me', owner.token, { themeColors: ['#ff0000'] })).status).toBe(400);
    expect((await api.req('PATCH', '/users/@me', owner.token, { themeColors: ['red', '#00ff00'] })).status).toBe(400);
    expect((await api.req('PATCH', '/users/@me', owner.token, { themeColors: ['#ff0000', '#0000ff'] })).body.themeColors).toEqual(['#ff0000', '#0000ff']);
    expect((await api.req('GET', `/users/${owner.id}`, peer.token)).body.themeColors).toEqual(['#ff0000', '#0000ff']);
    expect((await api.req('PATCH', '/users/@me', owner.token, { themeColors: null })).body.themeColors).toBeNull();
  });

  it('custom status expires server-side', async () => {
    const { owner, members } = await guildWith('watcher');
    const w = members[0] as any;
    const ws = await WsClient.connect(env.port); await ws.identify(w.token);
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await api.req('PATCH', '/users/@me', owner.token, { customStatus: { text: 'brb', emoji: null, expiresAt: past } })).status).toBe(400);
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const r = await api.req('PATCH', '/users/@me', owner.token, { customStatus: { text: 'brb', emoji: null, expiresAt: soon } });
    expect(r.body.customStatus).toMatchObject({ text: 'brb', expiresAt: soon });
    await env.ctx.db.query(`UPDATE users SET custom_status = jsonb_set(custom_status, '{expiresAt}', to_jsonb($2::text)) WHERE id = $1`, [owner.id, past]);
    expect((await api.req('GET', '/users/@me', owner.token)).body.customStatus).toBeNull(); // reads as cleared before the sweeper runs
    await runSweeps(env.ctx);
    expect((await env.ctx.db.query('SELECT custom_status FROM users WHERE id = $1', [owner.id]))[0].custom_status).toBeNull();
    ws.close();
  });
});
