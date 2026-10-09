import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import type { PushDevice, PushPayload, PushResult } from '../src/services/push';

let env: TestEnv, api: Api;
const sent: { dev: PushDevice; payload: PushPayload }[] = [];
let nextResult: PushResult = 'ok';
beforeAll(async () => {
  env = await startServer(); api = new Api(env);
  const fake = async (dev: PushDevice, payload: PushPayload): Promise<PushResult> => { sent.push({ dev, payload }); return nextResult; };
  env.ctx.push.senders.web = fake; env.ctx.push.senders.fcm = fake; env.ctx.push.senders.apns = null;
});
afterAll(async () => { await env.close(); });

let seq = 0;
const sub = () => ({ endpoint: `https://push.example.test/send/${++seq}-${Math.random().toString(36).slice(2)}`, keys: { p256dh: 'BP' + 'x'.repeat(40), auth: 'a'.repeat(16) } });
const webDevice = async (c: Client) => (await api.req('POST', '/users/@me/push-devices', c.token, { platform: 'web', subscription: sub() }));
const androidDevice = async (c: Client, token = `fcm-token-${++seq}-${Math.random().toString(36).slice(2)}`) => ({ token, res: await api.req('POST', '/users/@me/push-devices', c.token, { platform: 'android', token }) });
const flush = () => env.ctx.push.flush();
const to = (c: Client) => sent.filter((s) => s.dev.userId === c.id);
const reset = () => { sent.length = 0; nextResult = 'ok'; };

async function guildWith(...names: string[]) {
  const owner = await api.register('po');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Push', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  return { owner, guild, members, general: guild.channels.find((c: any) => c.type === 'text' && c.name === 'general') };
}
const post = (c: Client, channelId: string, content: string, extra: object = {}) => api.req('POST', `/channels/${channelId}/messages`, c.token, { content, ...extra });

describe('push device registration', () => {
  it('exposes the VAPID public key without auth and persists generated keys in the data dir', async () => {
    const r = await api.req('GET', '/push/vapid-public-key', null);
    expect(r.status).toBe(200); expect(r.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(existsSync(join(env.dir, 'vapid.json'))).toBe(true);
  });

  it('registers web and android devices, rejects bad input and unauthenticated calls', async () => {
    const u = await api.register('dev');
    expect((await webDevice(u)).status).toBe(201);
    expect((await androidDevice(u)).res.status).toBe(201);
    expect((await api.req('POST', '/users/@me/push-devices', null, { platform: 'android', token: 'abcdefgh1234' })).status).toBe(401);
    expect((await api.req('POST', '/users/@me/push-devices', u.token, { platform: 'android' })).status).toBe(400);           // token required
    expect((await api.req('POST', '/users/@me/push-devices', u.token, { platform: 'web', token: 'abcdefgh1234' })).status).toBe(400); // subscription required
    expect((await api.req('POST', '/users/@me/push-devices', u.token, { platform: 'toaster', token: 'abcdefgh1234' })).status).toBe(400);
    expect((await api.req('GET', '/users/@me/push-devices', u.token)).body).toHaveLength(2);
  });

  it('refuses web push endpoints that would make the server call internal hosts (SSRF)', async () => {
    const u = await api.register('ssrf');
    for (const endpoint of ['http://push.example.test/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://push.example.test:8443/x', 'https://user:pw@push.example.test/x', 'https://intranet/x', 'https://db.internal/x', 'file:///etc/passwd']) {
      const r = await api.req('POST', '/users/@me/push-devices', u.token, { platform: 'web', subscription: { ...sub(), endpoint } });
      expect(r.status, endpoint).toBe(400);
    }
  });

  it('unregisters by token and by id, only ever the caller\'s own devices (IDOR)', async () => {
    const a = await api.register('ua'), b = await api.register('ub');
    const { token, res } = await androidDevice(a);
    // b cannot remove a's device by id or by token
    expect((await api.req('DELETE', `/users/@me/push-devices/${res.body.id}`, b.token)).status).toBe(404);
    expect((await api.req('DELETE', '/users/@me/push-devices', b.token, { token })).status).toBe(204);
    expect((await api.req('GET', '/users/@me/push-devices', a.token)).body).toHaveLength(1);
    expect((await api.req('DELETE', `/users/@me/push-devices?token=${token}`, a.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/push-devices', a.token)).body).toHaveLength(0);
    expect((await api.req('DELETE', `/users/@me/push-devices?token=${token}`, a.token)).status).toBe(204); // idempotent
  });

  it('moves a device to the latest account that registers it, and signing out forgets the session\'s devices', async () => {
    const a = await api.register('h1'), b = await api.register('h2');
    const { token } = await androidDevice(a);
    expect((await api.req('POST', '/users/@me/push-devices', b.token, { platform: 'android', token })).status).toBe(201);
    expect((await api.req('GET', '/users/@me/push-devices', a.token)).body).toHaveLength(0);
    expect((await api.req('GET', '/users/@me/push-devices', b.token)).body).toHaveLength(1);
    await api.req('POST', '/auth/logout', b.token);
    const n = await env.ctx.db.query('SELECT 1 FROM push_devices WHERE token = $1', [token]);
    expect(n).toHaveLength(0);
  });
});

describe('push delivery', () => {
  it('pushes a DM to the offline recipient only and removes dead devices', async () => {
    const a = await api.register('dm1'), b = await api.register('dm2');
    await webDevice(a); await webDevice(b); await androidDevice(b);
    const g = await guildWith(); const code = (await api.req('POST', `/guilds/${g.guild.id}/invites`, g.owner.token, {})).body.code; // DMs need a shared server
    await api.req('POST', `/invites/${code}`, a.token); await api.req('POST', `/invites/${code}`, b.token);
    const dm = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    reset();
    await post(a, dm.id, 'hello <@123> there');
    await flush();
    expect(to(a)).toHaveLength(0);
    expect(to(b)).toHaveLength(2); // web + android
    const p = to(b)[0]!.payload;
    expect(p).toMatchObject({ kind: 'dm', channelId: dm.id, guildId: null, body: 'hello @user there' });
    // permanently invalid tokens are forgotten
    reset(); nextResult = 'gone';
    await post(a, dm.id, 'again'); await flush();
    expect((await api.req('GET', '/users/@me/push-devices', b.token)).body).toHaveLength(0);
  });

  it('skips users who are online on a gateway session', async () => {
    const a = await api.register('on1'), b = await api.register('on2');
    await webDevice(b);
    const g = await guildWith(); const code = (await api.req('POST', `/guilds/${g.guild.id}/invites`, g.owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, a.token); await api.req('POST', `/invites/${code}`, b.token);
    const dm = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    const w = await WsClient.connect(env.port); await w.identify(b.token);
    reset(); await post(a, dm.id, 'you there?'); await flush();
    expect(to(b)).toHaveLength(0);
    w.close(); await new Promise((r) => setTimeout(r, 100));
    reset(); await post(a, dm.id, 'now offline'); await flush();
    expect(to(b)).toHaveLength(1);
  });

  it('honours DND and the push toggle', async () => {
    const { owner, members: [b], general } = await guildWith('dnd');
    await webDevice(b!);
    reset();
    await api.req('PUT', '/users/@me/presence', b!.token, { presence: 'dnd' });
    await post(owner, general.id, `hey <@${b!.id}>`); await flush();
    expect(to(b!)).toHaveLength(0);
    await api.req('PUT', '/users/@me/presence', b!.token, { presence: 'invisible' });
    await post(owner, general.id, `hey <@${b!.id}>`); await flush();
    expect(to(b!)).toHaveLength(1);
    reset();
    expect((await api.req('PATCH', '/users/@me/notification-settings', b!.token, { pushEnabled: false })).body.pushEnabled).toBe(false);
    await post(owner, general.id, `hey <@${b!.id}>`); await flush();
    expect(to(b!)).toHaveLength(0);
  });

  it('notifies mentions, replies and @everyone but not ordinary guild chatter; respects visibility', async () => {
    const { owner, guild, members: [m1, m2, m3], general } = await guildWith('m1', 'm2', 'm3');
    for (const m of [m1!, m2!, m3!]) await webDevice(m);
    reset();
    await post(owner, general.id, 'plain message'); await flush();
    expect(sent).toHaveLength(0);
    await post(owner, general.id, `<@${m1!.id}> look`); await flush();
    expect(sent.map((s) => s.dev.userId)).toEqual([m1!.id]);
    expect(sent[0]!.payload.kind).toBe('mention'); expect(sent[0]!.payload.title).toContain('#general');
    // reply to m2's own message notifies m2
    const mine = (await post(m2!, general.id, 'question')).body; reset();
    await post(owner, general.id, 'answer', { replyTo: mine.id }); await flush();
    expect(sent.map((s) => [s.dev.userId, s.payload.kind])).toEqual([[m2!.id, 'reply']]);
    // @everyone: owner may; everyone but the author is pinged; m3 suppresses it
    await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, m3!.token, { suppressEveryone: true });
    reset(); await post(owner, general.id, '@everyone standup'); await flush();
    expect(sent.map((s) => s.dev.userId).sort()).toEqual([m1!.id, m2!.id].sort());
    // a member without MENTION_EVERYONE cannot ping everyone
    reset(); await post(m1!, general.id, '@everyone spam'); await flush();
    expect(sent).toHaveLength(0);
    // hide #general from m1 -> a mention no longer reaches them
    await api.req('PUT', `/channels/${general.id}/permissions/${m1!.id}`, owner.token, { type: 'member', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    reset(); await post(owner, general.id, `<@${m1!.id}> secret`); await flush();
    expect(sent).toHaveLength(0);
  });

  it('respects guild mute, channel mute, timed mute and level=all', async () => {
    const { owner, guild, members: [m], general } = await guildWith('mu');
    await webDevice(m!);
    const ping = async () => { reset(); await post(owner, general.id, `<@${m!.id}> ping`); await flush(); return sent.length; };
    expect(await ping()).toBe(1);
    await api.req('PUT', `/users/@me/notification-settings/channels/${general.id}`, m!.token, { muted: true });
    expect(await ping()).toBe(0);
    await api.req('PUT', `/users/@me/notification-settings/channels/${general.id}`, m!.token, { muted: false });
    expect(await ping()).toBe(1);
    const future = new Date(Date.now() + 3600_000).toISOString(), past = new Date(Date.now() - 3600_000).toISOString();
    await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, m!.token, { muted: true, mutedUntil: future });
    expect(await ping()).toBe(0);
    await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, m!.token, { muted: true, mutedUntil: past });
    expect(await ping()).toBe(1); // expired
    await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, m!.token, { muted: false, level: 'all' });
    reset(); await post(owner, general.id, 'no mention at all'); await flush();
    expect(sent).toHaveLength(1);
    await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, m!.token, { level: 'none' });
    expect(await ping()).toBe(0);
    const all = (await api.req('GET', '/users/@me/notification-settings', m!.token)).body;
    expect(all.guilds[0]).toMatchObject({ guildId: guild.id, level: 'none' });
    expect((await api.req('DELETE', `/users/@me/notification-settings/guilds/${guild.id}`, m!.token)).status).toBe(204);
    expect(await ping()).toBe(1);
  });

  it('only lets members configure guild/channel settings (no row spam for foreign ids)', async () => {
    const { guild, general } = await guildWith();
    const outsider = await api.register('out');
    expect((await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, outsider.token, { muted: true })).status).toBe(404);
    expect((await api.req('PUT', `/users/@me/notification-settings/channels/${general.id}`, outsider.token, { muted: true })).status).toBe(404);
    expect((await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, outsider.token, { evil: 1 })).status).toBe(400);
  });

  it('notifies friend requests, accepts and rings group/DM calls', async () => {
    const a = await api.register('f1'), b = await api.register('f2');
    await webDevice(b); await webDevice(a);
    reset();
    await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' }); await flush();
    expect(sent.map((s) => [s.dev.userId, s.payload.kind])).toEqual([[b.id, 'friend_request']]);
    reset();
    await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'friend' }); await flush();
    expect(sent.map((s) => [s.dev.userId, s.payload.kind])).toEqual([[a.id, 'friend_accept']]);
    // call ring: first person into a DM voice channel rings the other participant
    const dm = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    const w = await WsClient.connect(env.port); await w.identify(a.token);
    reset();
    w.send({ op: 4, d: { channelId: dm.id } }); await w.waitEvent('VOICE_STATE_UPDATE', (d) => d.channelId === dm.id); await flush();
    expect(sent.map((s) => [s.dev.userId, s.payload.kind, s.payload.channelId])).toEqual([[b.id, 'call', dm.id]]);
    w.close();
  });
});

describe('transports', () => {
  it('the real web transport refuses to connect to internal addresses and no-ops FCM/APNs when unconfigured', async () => {
    const { createPush } = await import('../src/services/push');
    const real = createPush(env.ctx);
    expect(real.senders.fcm).toBeNull(); expect(real.senders.apns).toBeNull();
    const keys = { p256dh: 'BP' + 'x'.repeat(40), auth: 'a'.repeat(16) };
    const r = await real.senders.web({ id: '1', userId: '1', platform: 'web', token: 'https://localhost/send/abc', keys }, { kind: 'dm', title: 't', body: 'b', tag: 'x' });
    expect(r).toBe('error'); // SSRF_BLOCKED at connect time (DNS-rebinding-safe), never 'ok'
  });
  it('uses VAPID keys from the environment when provided', async () => {
    const webpush = (await import('web-push')).default; const k = webpush.generateVAPIDKeys();
    const e2 = await startServer({ push: { vapid: { publicKey: k.publicKey, privateKey: k.privateKey, subject: 'mailto:a@example.com' }, fcmServiceAccount: null, apns: null } });
    expect((await new Api(e2).req('GET', '/push/vapid-public-key', null)).body.publicKey).toBe(k.publicKey);
    await e2.close();
  });
});

describe('CORS for native wrappers', () => {
  it('allows capacitor/tauri/localhost origins with all verbs and rejects others', async () => {
    for (const origin of ['capacitor://localhost', 'https://localhost', 'http://localhost', 'tauri://localhost', 'http://tauri.localhost', 'http://localhost:5173']) {
      const r = await env.app.inject({ method: 'OPTIONS', url: '/api/v1/users/@me/push-devices', headers: { origin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization,content-type' } });
      expect(r.headers['access-control-allow-origin'], origin).toBe(origin);
      expect(String(r.headers['access-control-allow-methods'])).toMatch(/DELETE/);
      expect(String(r.headers['access-control-allow-methods'])).toMatch(/PATCH/);
    }
    const bad = await env.app.inject({ method: 'OPTIONS', url: '/api/v1/users/@me', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});
