import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, Perm } from '@jorcord/shared';
import { emptyState } from '../src/services/voice';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api, admin: Client;
beforeAll(async () => {
  env = await startServer(); api = new Api(env);
  admin = await api.register('secadmin');
  (env.ctx.config as any).superAdminId = admin.id;
});
afterAll(async () => { await env.close(); });

const PW = 'correct horse battery';

describe('QR login claim', () => {
  const create = async () => (await api.req('POST', '/auth/remote/create', null, {})).body;
  it('a code scanned by one account cannot be taken over by a second account, even concurrently', async () => {
    const a = await api.register('qa'), b = await api.register('qb');
    const c = await create();
    const [ra, rb] = await Promise.all([
      api.req('POST', '/auth/remote/scan', a.token, { id: c.id, scanSecret: c.scanSecret }),
      api.req('POST', '/auth/remote/scan', b.token, { id: c.id, scanSecret: c.scanSecret }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const owner = ra.status === 200 ? a : b, loser = ra.status === 200 ? b : a;
    // the loser can neither confirm nor re-scan; the winner can still approve
    expect((await api.req('POST', '/auth/remote/confirm', loser.token, { id: c.id, scanSecret: c.scanSecret, approve: true })).status).toBe(409);
    expect((await api.req('POST', '/auth/remote/scan', loser.token, { id: c.id, scanSecret: c.scanSecret })).status).toBe(409);
    expect((await api.req('POST', '/auth/remote/confirm', owner.token, { id: c.id, scanSecret: c.scanSecret, approve: true })).status).toBe(204);
    const done = await api.req('POST', '/auth/remote/poll', null, { id: c.id, pollSecret: c.pollSecret });
    expect(done.body.user.id).toBe(owner.id);
  });

  it('bot accounts cannot approve a QR login', async () => {
    const dev = await api.register('qdev');
    const app = (await api.req('POST', '/applications', dev.token, { name: 'qrbot' })).body;
    const c = await create();
    const r = await api.req('POST', '/auth/remote/scan', null, { id: c.id, scanSecret: c.scanSecret }, { authorization: `Bot ${app.token}` });
    expect(r.status).toBe(403);
  });
});

describe('super admin direct-message access', () => {
  it('reading a DM channel needs god mode and is audited; guild channels stay readable', async () => {
    const x = await api.register('dmx'), y = await api.register('dmy');
    const g = (await api.req('POST', '/guilds', x.token, { name: 'Shared' })).body;
    await api.req('POST', `/invites/${(await api.req('POST', `/guilds/${g.id}/invites`, x.token, {})).body.code}`, y.token);
    const dm = (await api.req('POST', '/users/@me/channels', x.token, { recipientIds: [y.id] })).body;
    await api.req('POST', `/channels/${dm.id}/messages`, x.token, { content: 'private chat' });
    const url = `/admin/channels/${dm.id}/messages`;
    expect((await api.req('GET', url, x.token)).status).toBe(404); // not the admin
    expect((await api.req('GET', url, admin.token)).status).toBe(400); // admin without god mode
    expect((await api.req('POST', '/admin/god-mode', admin.token, { enabled: true, password: PW })).status).toBe(200);
    const ok = await api.req('GET', url, admin.token);
    expect(ok.status).toBe(200); expect(ok.body[0].content).toBe('private chat');
    const audit = (await api.req('GET', '/admin/audit', admin.token)).body;
    expect(audit.some((a: any) => a.action === 'READ_DM' && a.path === url)).toBe(true);
    await api.req('POST', '/admin/god-mode', admin.token, { enabled: false });
    expect((await api.req('GET', url, admin.token)).status).toBe(400);
    expect((await api.req('GET', '/admin/channels/999999999999999999/messages', admin.token)).status).toBe(404);
  });
});

describe('forum default reaction emoji', () => {
  it('a custom default must be an emoji of the same server', async () => {
    const owner = await api.register('fo');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Forum', template: 'community' })).body;
    const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'posts', type: 'forum' })).body;
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultReactionEmoji: 'ghost:12345' })).status).toBe(400);
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultReactionEmoji: '👋' })).status).toBe(200);
  });
});

describe('super reaction allowance', () => {
  it('concurrent super reactions cannot exceed the daily allowance', async () => {
    const u = await api.register('burst');
    const guild = (await api.req('POST', '/guilds', u.token, { name: 'Burst' })).body;
    const ch = guild.channels.find((c: any) => c.name === 'general');
    const msg = (await api.req('POST', `/channels/${ch.id}/messages`, u.token, { content: 'react to me' })).body;
    const emojis = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂'];
    const res = await Promise.all(emojis.map((e) => api.req('PUT', `/channels/${ch.id}/messages/${msg.id}/reactions/${encodeURIComponent(e)}/@me`, u.token, { burst: true })));
    expect(res.filter((r) => r.status === 204)).toHaveLength(LIMITS.burstReactionsPerDay);
    expect(res.filter((r) => r.status === 429)).toHaveLength(emojis.length - LIMITS.burstReactionsPerDay);
  });
});

describe('voice recording stop', () => {
  it('a refused attachment post does not stop the recording', async () => {
    const owner = await api.register('rcowner'), rec = await api.register('rcrec');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Rec' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, rec.token);
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'rec', permissions: String(Perm.RECORD_VOICE) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${rec.id}`, owner.token, { roles: [role.id] });
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    await env.ctx.voice.set({ ...emptyState(rec.id), guildId: guild.id, channelId: voice.id });
    const b = 'XBOUNDARYX';
    const up = await api.req('POST', '/uploads', rec.token, Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="t.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`), Buffer.alloc(32, 1), Buffer.from(`\r\n--${b}--\r\n`)]) as any, { 'content-type': `multipart/form-data; boundary=${b}` });
    expect(up.status).toBe(201);
    // take ATTACH_FILES away from @everyone, then start and try to stop with the take attached
    const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === '@everyone');
    await api.req('PATCH', `/guilds/${guild.id}/roles/${everyone.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~Perm.ATTACH_FILES) });
    expect((await api.req('POST', `/channels/${voice.id}/voice/recording/start`, rec.token)).status).toBe(200);
    expect((await api.req('POST', `/channels/${voice.id}/voice/recording/stop`, rec.token, { attachments: [up.body.id] })).status).toBe(403);
    const [still] = await env.ctx.db.query('SELECT 1 AS x FROM voice_recordings WHERE channel_id = $1 AND stopped_at IS NULL', [voice.id]);
    expect(still).toBeTruthy();
    expect((await api.req('POST', `/channels/${voice.id}/voice/recording/stop`, rec.token, {})).status).toBe(200);
  });
});
