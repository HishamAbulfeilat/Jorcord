import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const create = async () => (await api.req('POST', '/auth/remote/create', null, {}, { 'user-agent': 'TestBrowser/1.0' })).body;
const poll = (c: any, secret = c.pollSecret) => api.req('POST', '/auth/remote/poll', null, { id: c.id, pollSecret: secret }, { 'user-agent': 'TestBrowser/1.0' });
const scan = (c: any, token: string | null, secret = c.scanSecret) => api.req('POST', '/auth/remote/scan', token, { id: c.id, scanSecret: secret });
const confirm = (c: any, token: string | null, approve = true) => api.req('POST', '/auth/remote/confirm', token, { id: c.id, scanSecret: c.scanSecret, approve });

describe('QR code login (remote auth)', () => {
  it('logs the waiting device in as a new, revocable session after the phone confirms', async () => {
    const phone = await api.register('qr');
    const c = await create();
    expect(c.pollSecret).not.toBe(c.scanSecret);
    expect((await poll(c)).body.status).toBe('pending');
    const s = await scan(c, phone.token);
    expect(s.status).toBe(200); expect(s.body.device.userAgent).toBe('TestBrowser/1.0');
    expect((await poll(c)).body.status).toBe('scanned');
    expect((await confirm(c, phone.token)).status).toBe(204);
    const done = await poll(c);
    expect(done.status).toBe(200); expect(done.body.status).toBe('approved');
    expect(done.body.user.id).toBe(phone.id);
    expect((await api.req('GET', '/users/@me', done.body.accessToken)).status).toBe(200);
    // it is a normal session: listed under Devices, and revoking it kills the new device only
    const sessions = (await api.req('GET', '/auth/sessions', phone.token)).body;
    expect(sessions.length).toBe(2);
    const other = sessions.find((x: any) => !x.current);
    expect(other.userAgent).toBe('TestBrowser/1.0');
    expect((await api.req('POST', '/auth/sessions', phone.token, { sessionId: other.id })).status).toBe(204);
    expect((await api.req('GET', '/users/@me', done.body.accessToken)).status).toBe(401);
    expect((await api.req('GET', '/users/@me', phone.token)).status).toBe(200);
  });

  it('is single use', async () => {
    const phone = await api.register('qr');
    const c = await create();
    await scan(c, phone.token); await confirm(c, phone.token);
    expect((await poll(c)).body.status).toBe('approved');
    const again = await poll(c);
    expect(again.status).toBe(410); expect(again.body.code).toBe('REMOTE_AUTH_EXPIRED');
    expect((await scan(c, phone.token)).status).toBe(410);
    expect((await confirm(c, phone.token)).status).toBe(410);
  });

  it('only one approved poll wins when polls race', async () => {
    const phone = await api.register('qr');
    const c = await create();
    await scan(c, phone.token); await confirm(c, phone.token);
    const rs = await Promise.all([poll(c), poll(c), poll(c)]);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
  });

  it('expires after its short lifetime', async () => {
    const phone = await api.register('qr');
    const c = await create();
    expect(new Date(c.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 60_000);
    const s = await scan(c, phone.token); expect(s.status).toBe(200);
    await env.ctx.db.query(`UPDATE remote_auth SET expires_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
    expect((await poll(c)).status).toBe(410);
    expect((await scan(c, phone.token)).status).toBe(410);
    expect((await confirm(c, phone.token)).status).toBe(410);
  });

  it('expiry also voids an already approved code', async () => {
    const phone = await api.register('qr');
    const c = await create();
    await scan(c, phone.token); await confirm(c, phone.token);
    await env.ctx.db.query(`UPDATE remote_auth SET expires_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
    expect((await poll(c)).status).toBe(410);
  });

  it('rejects wrong secrets', async () => {
    const phone = await api.register('qr');
    const c = await create();
    const bogus = 'x'.repeat(32);
    expect((await poll(c, bogus)).status).toBe(404);
    expect((await poll(c, c.scanSecret)).status).toBe(404); // the QR secret cannot poll
    expect((await scan(c, phone.token, bogus)).status).toBe(404);
    expect((await scan(c, phone.token, c.pollSecret)).status).toBe(404); // the poll secret cannot scan
    expect((await api.req('POST', '/auth/remote/poll', null, { id: '123456', pollSecret: bogus })).status).toBe(404);
    expect((await poll(c)).body.status).toBe('pending');
  });

  it('requires an authenticated scanner and a scan before confirm', async () => {
    const phone = await api.register('qr');
    const c = await create();
    expect((await scan(c, null)).status).toBe(401);
    expect((await scan(c, 'not-a-token')).status).toBe(401);
    expect((await confirm(c, null)).status).toBe(401);
    expect((await confirm(c, phone.token)).status).toBe(409); // not scanned yet
    expect((await poll(c)).body.status).toBe('pending');
  });

  it('cannot be confirmed or taken over by a different user than the scanner', async () => {
    const a = await api.register('qr'), b = await api.register('qr');
    const c = await create();
    await scan(c, a.token);
    expect((await confirm(c, b.token)).status).toBe(409);
    expect((await scan(c, b.token)).status).toBe(409);
    expect((await poll(c)).body.status).toBe('scanned');
  });

  it('declining stops the waiting device', async () => {
    const phone = await api.register('qr');
    const c = await create();
    await scan(c, phone.token); await confirm(c, phone.token, false);
    const r = await poll(c);
    expect(r.status).toBe(403); expect(r.body.code).toBe('REMOTE_AUTH_DENIED');
  });

  it('bots cannot scan', async () => {
    const c = await create();
    expect((await api.req('POST', '/auth/remote/scan', null, { id: c.id, scanSecret: c.scanSecret }, { authorization: 'Bot nope' })).status).toBe(401);
  });

  it('rate-limits code creation', async () => {
    const limited = await startServer({ rateLimit: true });
    try {
      const a = new Api(limited);
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await a.req('POST', '/auth/remote/create', null, {})).status);
      expect(codes.slice(0, 10).every((s) => s === 201)).toBe(true);
      expect(codes.includes(429)).toBe(true);
    } finally { await limited.close(); }
  });
});
