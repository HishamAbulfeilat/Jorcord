import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityOrigin } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { parseAuditReason } from '../src/lib/auditReason';
import { buildCsp } from '../src/lib/webapp';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const botReq = (method: string, url: string, token: string, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${token}` });
// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
};

describe('application emoji', () => {
  it('bot token and owner can CRUD; others get 404; public lookup redirects to the image', async () => {
    const owner = await api.register('emo'), other = await api.register('emx');
    const a = (await api.req('POST', '/applications', owner.token, { name: 'emojibot', description: 'bot with emoji', botPublic: true })).body;
    const created = await api.req('POST', `/applications/${a.id}/emojis`, owner.token, { name: 'party', image: PNG });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ applicationId: a.id, name: 'party', animated: false });
    expect(created.body.url).toMatch(/^\/api\/v1\/files\//);
    // the bot itself can list and rename
    const list = await botReq('GET', `/applications/${a.id}/emojis`, a.token);
    expect(list.body.items).toHaveLength(1);
    expect((await botReq('PATCH', `/applications/${a.id}/emojis/${created.body.id}`, a.token, { name: 'party2' })).body.name).toBe('party2');
    // strangers cannot see or touch it
    expect((await api.req('GET', `/applications/${a.id}/emojis`, other.token)).status).toBe(404);
    expect((await api.req('POST', `/applications/${a.id}/emojis`, other.token, { name: 'nope', image: PNG })).status).toBe(404);
    // bad input
    expect((await api.req('POST', `/applications/${a.id}/emojis`, owner.token, { name: 'bad name', image: PNG })).status).toBe(400);
    expect((await api.req('POST', `/applications/${a.id}/emojis`, owner.token, { name: 'fake', image: 'data:image/png;base64,AAAA' })).status).toBe(400); // not an image
    expect((await api.req('POST', `/applications/${a.id}/emojis`, owner.token, { name: 'both', image: PNG, url: '/api/v1/files/' + 'a'.repeat(48) + '/e.png' })).status).toBe(400);
    // GET /emojis/:id is public: metadata, and a redirect for image extensions
    const meta = await api.req('GET', `/emojis/${created.body.id}`, null);
    expect(meta.body).toMatchObject({ id: created.body.id, applicationId: a.id, guildId: null });
    const img = await env.app.inject({ method: 'GET', url: `/api/v1/emojis/${created.body.id}.webp` });
    expect(img.statusCode).toBe(302);
    expect(img.headers.location).toBe(created.body.url);
    expect((await api.req('GET', '/emojis/99999999999', null)).status).toBe(404);
    // a bot may post the emoji in a message (it is plain content)
    expect((await botReq('DELETE', `/applications/${a.id}/emojis/${created.body.id}`, a.token)).status).toBe(204);
    expect((await api.req('GET', `/emojis/${created.body.id}`, null)).status).toBe(404);
  });
});

describe('REST compat', () => {
  it('serves /api/v10 and /api/v9 like /api/v1 and keeps the bot gates', async () => {
    const u = await api.register('v10');
    for (const v of ['v10', 'v9']) {
      const r = await env.app.inject({ method: 'GET', url: `/api/${v}/users/@me`, headers: { authorization: `Bearer ${u.token}` } });
      expect(r.statusCode).toBe(200);
      expect(r.json().id).toBe(u.id);
    }
    const a = (await api.req('POST', '/applications', u.token, { name: 'gatebot', description: 'bot for the gate test', botPublic: true })).body;
    const blocked = await env.app.inject({ method: 'POST', url: '/api/v10/oauth2/authorize', headers: { authorization: `Bot ${a.token}` }, payload: {} });
    expect(blocked.statusCode).toBe(403); // BOT_BLOCKED still applies through the alias
    expect((await env.app.inject({ method: 'GET', url: '/api/v1x/users/@me' })).statusCode).toBe(404);
  });
  it('parses X-Audit-Log-Reason and writes it to the audit log', async () => {
    expect(parseAuditReason('spam%20bot%20%E2%9C%93')).toBe('spam bot ✓');
    expect(parseAuditReason('%E0%A4%A')).toBeNull(); // malformed encoding is ignored, not an error
    expect(parseAuditReason('x'.repeat(600))).toHaveLength(512);
    expect(parseAuditReason('')).toBeNull();
    const owner = await api.register('aud');
    const g = (await api.req('POST', '/guilds', owner.token, { name: 'Audit' })).body;
    const r = await api.req('POST', `/guilds/${g.id}/emojis`, owner.token, { name: 'smile', url: '/api/v1/files/' + 'b'.repeat(48) + '/e.png' }, { 'x-audit-log-reason': 'added%20for%20the%20launch' });
    expect(r.status).toBe(201);
    const logs = (await api.req('GET', `/guilds/${g.id}/audit-logs`, owner.token)).body;
    const entries = Array.isArray(logs) ? logs : logs.entries ?? logs.auditLogEntries ?? [];
    expect(entries.find((e: any) => e.action === 'EMOJI_CREATE')?.reason).toBe('added for the launch');
  });
});

describe('user-installable apps', () => {
  it('install to a user account, list commands, run them in a private channel and a guild without the bot, replies are ephemeral', async () => {
    const dev = await api.register('dev'), alice = await api.register('alice'), bob = await api.register('bob'), stranger = await api.register('str');
    const a = (await api.req('POST', '/applications', dev.token, { name: 'useapp', description: 'a user installable app', botPublic: true })).body;
    // guild commands cannot be user-installable
    const bot = a.token as string;
    const cmd = await botReq('POST', `/applications/${a.id}/commands`, bot, { name: 'hello', description: 'say hello', integrationTypes: [0, 1], contexts: [0, 1, 2] });
    expect(cmd.status).toBe(201);
    expect(cmd.body).toMatchObject({ integrationTypes: [0, 1], contexts: [0, 1, 2] });
    const guildOnly = await botReq('POST', `/applications/${a.id}/commands`, bot, { name: 'plain', description: 'guild install only' });
    expect(guildOnly.body).toMatchObject({ integrationTypes: [0], contexts: null });
    expect((await botReq('PATCH', `/applications/${a.id}/commands/${cmd.body.id}`, bot, { contexts: [0] })).body.contexts).toEqual([0]);
    expect((await botReq('PATCH', `/applications/${a.id}/commands/${cmd.body.id}`, bot, { contexts: [0, 1, 2] })).body.contexts).toEqual([0, 1, 2]);

    // nothing installed yet: no commands, cannot use them
    expect((await api.req('GET', '/users/@me/application-commands', alice.token)).body.commands).toHaveLength(0);
    const shared = (await api.req('POST', '/guilds', alice.token, { name: 'Shared' })).body;
    await api.req('POST', `/invites/${(await api.req('POST', `/guilds/${shared.id}/invites`, alice.token, {})).body.code}`, bob.token);
    const dm = (await api.req('POST', '/users/@me/channels', alice.token, { recipientIds: [bob.id] })).body;
    const bareTry = await api.req('POST', '/interactions', alice.token, { type: 2, channelId: dm.id, data: { id: cmd.body.id } });
    expect(bareTry.status, JSON.stringify(bareTry.body) + JSON.stringify(dm)).toBe(403);

    // user install: only applications.commands, never bot
    expect((await api.req('POST', '/oauth2/authorize', alice.token, { clientId: a.id, scope: 'bot applications.commands', integrationType: 1 })).status).toBe(400);
    const inst = await api.req('POST', '/oauth2/authorize', alice.token, { clientId: a.id, scope: 'applications.commands', integrationType: 1 });
    expect(inst.status).toBe(200);
    expect(inst.body.userInstalled).toBe(true);
    const mine = (await api.req('GET', '/users/@me/application-commands', alice.token)).body;
    expect(mine.commands.map((c: any) => c.name)).toEqual(['hello']); // 'plain' is guild-install only
    expect(mine.applications[0].id).toBe(a.id);
    expect((await api.req('GET', '/users/@me/application-installs', alice.token)).body).toHaveLength(1);
    expect((await api.req('GET', '/users/@me/application-commands', bob.token)).body.commands).toHaveLength(0);

    const ws = await WsClient.connect(env.port);
    await ws.identify(`Bot ${bot}`);
    const aws = await WsClient.connect(env.port);
    await aws.identify(alice.token);
    const answer = async (ix: any, text: string) => botReq('POST', `/interactions/${ix.id}/${ix.token}/callback`, bot, { type: 4, data: { content: text } });

    // 1. private channel (DM between two humans, the bot is not in it)
    const r1 = await api.req('POST', '/interactions', alice.token, { type: 2, channelId: dm.id, data: { id: cmd.body.id } });
    expect(r1.status).toBe(202);
    const ix1 = (await ws.waitEvent('INTERACTION_CREATE', (d) => d.id === r1.body.id)).d;
    expect(ix1.context).toBe(2);
    expect(ix1.authorizingIntegrationOwners).toEqual({ '1': alice.id });
    const eph = aws.waitEvent('MESSAGE_CREATE', (d) => d.content === 'hi alice');
    expect((await answer(ix1, 'hi alice')).status).toBe(204);
    const m = (await eph).d;
    expect(m.flags & (1 << 6)).toBeTruthy(); // forced ephemeral: bob never sees it, it was not posted to the DM
    expect((await api.req('GET', `/channels/${dm.id}/messages`, bob.token)).body.filter((x: any) => x.content === 'hi alice')).toHaveLength(0);

    // 2. a guild where the bot is not a member
    const g = (await api.req('POST', '/guilds', alice.token, { name: 'Elsewhere' })).body;
    const general = g.channels.find((c: any) => c.name === 'general');
    const r2 = await api.req('POST', '/interactions', alice.token, { type: 2, channelId: general.id, data: { id: cmd.body.id } });
    expect(r2.status).toBe(202);
    const ix2 = (await ws.waitEvent('INTERACTION_CREATE', (d) => d.id === r2.body.id)).d;
    expect(ix2.context).toBe(0);
    expect(ix2.authorizingIntegrationOwners).toEqual({ '1': alice.id });
    expect((await answer(ix2, 'public?')).status).toBe(204);
    expect((await aws.waitEvent('MESSAGE_CREATE', (d) => d.content === 'public?')).d.flags & (1 << 6)).toBeTruthy();
    expect((await api.req('GET', `/channels/${general.id}/messages`, alice.token)).body.filter((x: any) => x.content === 'public?')).toHaveLength(0);
    // a guild-install-only command is not usable through a user install
    const r3 = await api.req('POST', '/interactions', alice.token, { type: 2, channelId: general.id, data: { id: guildOnly.body.id } });
    expect(r3.status).toBe(403);
    // someone who did not install it cannot use it there either
    const code = (await api.req('POST', `/guilds/${g.id}/invites`, alice.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, stranger.token);
    expect((await api.req('POST', '/interactions', stranger.token, { type: 2, channelId: general.id, data: { id: cmd.body.id } })).status).toBe(403);

    // restricting contexts removes the private-channel use
    await botReq('PATCH', `/applications/${a.id}/commands/${cmd.body.id}`, bot, { contexts: [0] });
    expect((await api.req('POST', '/interactions', alice.token, { type: 2, channelId: dm.id, data: { id: cmd.body.id } })).status).toBe(403);

    // uninstall
    expect((await api.req('DELETE', `/users/@me/application-installs/${a.id}`, alice.token)).status).toBe(204);
    expect((await api.req('DELETE', `/users/@me/application-installs/${a.id}`, alice.token)).status).toBe(404);
    expect((await api.req('POST', '/interactions', alice.token, { type: 2, channelId: general.id, data: { id: cmd.body.id } })).status).toBe(403);
    // guild commands cannot be user-installable
    const gc = await botReq('POST', `/applications/${a.id}/guilds/${g.id}/commands`, bot, { name: 'gcmd', description: 'x', integrationTypes: [1] });
    expect(gc.status).toBe(403); // app is not installed in that guild at all
    ws.close(); aws.close();
  });
});

describe('embedded activities', () => {
  it('validates the activity URL, launches an app activity in a voice channel and shares its state', async () => {
    const dev = await api.register('act'), friend = await api.register('actf');
    const a = (await api.req('POST', '/applications', dev.token, { name: 'iframeapp', description: 'an embedded activity', botPublic: true })).body;
    expect((await api.req('PATCH', `/applications/${a.id}`, dev.token, { activityUrl: 'http://insecure.example.com/' })).status).toBe(400);
    expect((await api.req('PATCH', `/applications/${a.id}`, dev.token, { activityUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await api.req('PATCH', `/applications/${a.id}`, dev.token, { activityUrl: 'https://user:pw@example.com/' })).status).toBe(400);
    const ok = await api.req('PATCH', `/applications/${a.id}`, dev.token, { activityUrl: 'https://game.example.com/play?x=1' });
    expect(ok.status).toBe(200);
    expect(ok.body.activityUrl).toBe('https://game.example.com/play?x=1');

    const g = (await api.req('POST', '/guilds', dev.token, { name: 'Play' })).body;
    const code = (await api.req('POST', `/guilds/${g.id}/invites`, dev.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, friend.token);
    const voice = g.channels.find((c: any) => c.type === 'voice');
    // not in the call yet
    expect((await api.req('POST', `/channels/${voice.id}/activities`, dev.token, { applicationId: a.id })).status).toBe(403);
    await env.ctx.voice.set({ userId: dev.id, guildId: g.id, channelId: voice.id, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false } as any);
    await env.ctx.voice.set({ userId: friend.id, guildId: g.id, channelId: voice.id, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false } as any);
    // an app without an activity URL cannot be launched
    const noUrl = (await api.req('POST', '/applications', dev.token, { name: 'plainapp', description: 'no activity here', botPublic: true })).body;
    expect((await api.req('POST', `/channels/${voice.id}/activities`, dev.token, { applicationId: noUrl.id })).status).toBe(404);
    expect((await api.req('GET', `/channels/${voice.id}/activity-apps`, dev.token)).body.apps.map((x: any) => x.name)).toEqual(['iframeapp']); // own app, plain app has no URL
    expect((await api.req('GET', `/channels/${voice.id}/activity-apps`, friend.token)).body.apps).toEqual([]); // not installed in this server
    const started = await api.req('POST', `/channels/${voice.id}/activities`, dev.token, { applicationId: a.id, state: { round: 1 } });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'app', applicationId: a.id, hostId: dev.id, state: { round: 1 }, application: { name: 'iframeapp', activityUrl: 'https://game.example.com/play?x=1' } });
    expect((await api.req('POST', `/channels/${voice.id}/activities`, friend.token, { applicationId: a.id })).status).toBe(409);
    // any participant can write the shared state
    const upd = await api.req('PATCH', `/activities/${started.body.id}/state`, friend.token, { state: { round: 2 } });
    expect(upd.status).toBe(200);
    expect(upd.body.state).toEqual({ round: 2 });
    expect((await api.req('PATCH', `/activities/${started.body.id}/state`, friend.token, { state: { blob: 'x'.repeat(5000) } })).status).toBe(400);
    expect((await api.req('DELETE', `/activities/${started.body.id}`, dev.token)).status).toBe(204);
  });
  it('adds only https activity origins to the web CSP frame-src', () => {
    expect(activityOrigin('https://game.example.com/a/b?c')).toBe('https://game.example.com');
    expect(activityOrigin('http://game.example.com')).toBeNull();
    expect(activityOrigin('https://u:p@game.example.com')).toBeNull();
    expect(buildCsp()).toContain("frame-src 'self';");
    const csp = buildCsp({ frameSrc: ['https://game.example.com', 'http://evil.example.com', "https://x.com; script-src *"] });
    expect(csp).toContain("frame-src 'self' https://game.example.com;");
    expect(csp).not.toContain('evil');
    expect(csp).not.toContain('script-src *');
  });
});
