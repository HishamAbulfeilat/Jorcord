import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { isPrivateIp } from '../src/lib/ssrf';
import { redactUrl } from '../src/lib/security';
import { loadConfig, DEFAULT_CORS_ORIGINS } from '../src/config';
import { MAX_UNATTACHED_UPLOADS } from '../src/services/files';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function multipart(name: string, data: Buffer, type: string) {
  const b = '----jc' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
async function upload(c: Client, name: string, data: Buffer, type: string) {
  const m = multipart(name, data, type);
  const res = await env.app.inject({ method: 'POST', url: '/api/v1/uploads', payload: m.body, headers: { ...m.headers, authorization: `Bearer ${c.token}` } });
  return { status: res.statusCode, body: res.json() };
}

describe('response hardening', () => {
  it('sets helmet-equivalent headers and forbids caching API responses', async () => {
    const u = await api.register('hdr');
    const r = await api.req('GET', '/users/@me', u.token);
    const h = r.raw.headers;
    expect(h['x-content-type-options']).toBe('nosniff'); expect(h['x-frame-options']).toBe('DENY'); expect(h['referrer-policy']).toBe('no-referrer');
    expect(String(h['content-security-policy'])).toContain("default-src 'none'"); expect(h['cache-control']).toBe('no-store');
    expect(h['cross-origin-opener-policy']).toBe('same-origin'); expect(h['x-powered-by']).toBeUndefined();
    const health = await env.app.inject({ method: 'GET', url: '/health' });
    expect(health.headers['x-frame-options']).toBe('DENY');
  });

  it('serves user files sandboxed; non-images are downloads, fake images are demoted to octet-stream', async () => {
    const u = await api.register('up');
    const html = await upload(u, 'x.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    const fake = await upload(u, 'evil.png', Buffer.from('<script>alert(1)</script>'), 'image/png'); // claims PNG, is HTML
    const real = await upload(u, 'ok.png', PNG, 'image/png');
    const fetchFile = (a: any) => env.app.inject({ method: 'GET', url: a.body.url });
    const h = await fetchFile(html), f = await fetchFile(fake), ok = await fetchFile(real);
    expect(h.headers['content-type']).toBe('application/octet-stream'); expect(String(h.headers['content-disposition'])).toMatch(/^attachment/);
    expect(f.headers['content-type']).toBe('application/octet-stream'); expect(fake.body.contentType).toBe('application/octet-stream');
    expect(ok.headers['content-type']).toBe('image/png'); expect(real.body.width).toBe(1);
    for (const r of [h, f, ok]) { expect(r.headers['content-security-policy']).toContain('sandbox'); expect(r.headers['x-content-type-options']).toBe('nosniff'); }
  });

  it('caps outstanding (unattached) uploads per user', async () => {
    const u = await api.register('cap');
    await env.ctx.db.query(`INSERT INTO files (id, key, uploader_id, filename, content_type, size) SELECT 'f' || g::text, 'cap' || lpad(g::text, 20, '0'), $1, 'a', 'text/plain', 1 FROM generate_series(1, ${MAX_UNATTACHED_UPLOADS}) g`, [u.id]);
    const r = await upload(u, 'one.png', PNG, 'image/png');
    expect(r.status).toBe(429); expect(r.body.code).toBe('TOO_MANY_UPLOADS');
  });

  it('redacts capability secrets and query strings from logged URLs', () => {
    expect(redactUrl('/api/v1/webhooks/123/SECRETTOKEN?wait=true')).toBe('/api/v1/webhooks/123/[redacted]');
    expect(redactUrl(`/api/v1/files/${'a'.repeat(48)}/pic.png`)).toBe('/api/v1/files/[redacted]/pic.png');
    expect(redactUrl('/api/v1/unfurl?url=https://x.test/?token=abc')).toBe('/api/v1/unfurl');
  });
});

describe('config', () => {
  it('defaults CORS to the wrapper origins plus PUBLIC_URL and supports overrides', () => {
    const c = loadConfig({}, { DATA_DIR: env.dir, PUBLIC_URL: 'https://chat.example.org/app' });
    expect(c.corsOrigins).toEqual(expect.arrayContaining([...DEFAULT_CORS_ORIGINS, 'https://chat.example.org']));
    for (const o of ['capacitor://localhost', 'https://localhost', 'http://localhost', 'tauri://localhost', 'http://tauri.localhost', 'http://localhost:5173']) expect(c.corsOrigins).toContain(o);
    expect(loadConfig({}, { DATA_DIR: env.dir, CORS_ORIGINS: 'https://a.test, https://b.test' }).corsOrigins).toEqual(expect.arrayContaining(['https://a.test', 'https://b.test', 'capacitor://localhost']));
    expect(loadConfig({}, { DATA_DIR: env.dir, CORS_ORIGINS: '*' }).corsOrigins).toBe(true);
  });
  it('refuses weak JWT secrets in production', () => {
    expect(() => loadConfig({}, { NODE_ENV: 'production', JWT_SECRET: 'short-but-16-chars!' })).toThrow(/32/);
    expect(() => loadConfig({}, { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), DATA_DIR: env.dir })).not.toThrow();
  });
});

describe('SSRF guard', () => {
  it('treats loopback, private, link-local, mapped and tunnelled IPv6 addresses as internal', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.5', '198.51.100.9', '203.0.113.7',
      '::1', '::', 'fe80::1', 'fec0::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '64:ff9b::7f00:1', 'ff02::1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('rejects unfurl of internal URLs', async () => {
    const u = await api.register('unf');
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://2130706433/', 'http://localhost/', 'http://127.1/']) {
      expect((await api.req('GET', `/unfurl?url=${encodeURIComponent(url)}`, u.token)).status, url).toBe(404);
    }
  });
});

describe('authentication hardening', () => {
  async function mfaUser() {
    const u = await api.register('mfa');
    const { secret } = (await api.req('POST', '/auth/mfa/setup', u.token)).body;
    await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(secret) });
    return { u, secret };
  }
  it('does not accept a TOTP code twice (replay) at login', async () => {
    const { u, secret } = await mfaUser();
    const code = authenticator.generate(secret);
    const login = (totp: string) => api.req('POST', '/auth/login', null, { email: `${u.username}@example.com`, password: 'correct horse battery', totp });
    expect((await login(code)).status).toBe(200);
    expect((await login(code)).status).toBe(401);
  });
  it('locks out MFA guessing: failed codes are throttled even with the right password', async () => {
    const lim = await startServer({ rateLimit: true }); const l = new Api(lim);
    const u = await l.register('mb'); const { secret } = (await l.req('POST', '/auth/mfa/setup', u.token)).body;
    await l.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(secret) });
    const attempt = (totp: string) => l.req('POST', '/auth/login', null, { email: `${u.username}@example.com`, password: 'correct horse battery', totp });
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await attempt(String(100000 + i))).status);
    expect(codes.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(codes.slice(6).every((s) => s === 429)).toBe(true);
    expect((await attempt(authenticator.generate(secret))).status).toBe(429); // a correct code does not bypass the lock
    await lim.close();
  });
  it('rate limits MFA enable/disable and registration', async () => {
    const lim = await startServer({ rateLimit: true }); const l = new Api(lim);
    const u = await l.register('mr'); await l.req('POST', '/auth/mfa/setup', u.token);
    let last = 0; for (let i = 0; i < 12; i++) last = (await l.req('POST', '/auth/mfa/enable', u.token, { code: '000000' })).status;
    expect(last).toBe(429);
    let reg = 0; for (let i = 0; i < 12; i++) reg = (await l.req('POST', '/auth/register', null, { email: `r${i}@example.com`, username: `rr${i}x`, password: 'correct horse battery' })).status;
    expect(reg).toBe(429);
    await lim.close();
  });
  it('rejects refresh tokens of deleted accounts and revoked sessions', async () => {
    const u = await api.register('rf');
    await api.req('POST', '/auth/logout', u.token);
    expect((await api.req('POST', '/auth/refresh', null, { refreshToken: u.refresh })).status).toBe(401);
  });
  it('rejects forged / alg-none / wrong-issuer access tokens', async () => {
    const { SignJWT } = await import('jose');
    const u = await api.register('jwt');
    const bad = await new SignJWT({ sid: '1' }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer('jorcord').setExpirationTime('5m').sign(new TextEncoder().encode('not-the-real-secret-xxxxxxxxxxxx'));
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: u.id, sid: '1', iss: 'jorcord', exp: 9999999999 })).toString('base64url')}.`;
    for (const t of [bad, none, 'garbage']) expect((await api.req('GET', '/users/@me', t)).status).toBe(401);
  });
});

describe('authorization / IDOR', () => {
  it('hides other users\' sessions, devices, channels and files', async () => {
    const a = await api.register('ia'), b = await api.register('ib');
    const sid = (await api.req('GET', '/auth/sessions', a.token)).body[0].id;
    expect((await api.req('POST', '/auth/sessions', b.token, { sessionId: sid })).status).toBe(404);
    expect((await api.req('GET', '/users/@me/channels', b.token)).body).toEqual([]);
    // a private guild's channel is a 404 (not 403) for outsiders, for every verb
    const g = (await api.req('POST', '/guilds', a.token, { name: 'Private' })).body;
    const ch = g.channels.find((c: any) => c.type === 'text');
    for (const [m, url, body] of [['GET', `/channels/${ch.id}`], ['GET', `/channels/${ch.id}/messages`], ['POST', `/channels/${ch.id}/messages`, { content: 'x' }], ['GET', `/channels/${ch.id}/pins`],
      ['POST', `/channels/${ch.id}/typing`], ['GET', `/guilds/${g.id}`], ['GET', `/guilds/${g.id}/members`], ['GET', `/guilds/${g.id}/audit-logs`], ['GET', `/guilds/${g.id}/messages/search?q=x`],
      ['PATCH', `/channels/${ch.id}`, { name: 'pwn' }], ['DELETE', `/channels/${ch.id}`], ['GET', `/channels/${ch.id}/webhooks`]] as [string, string, object?][]) {
      const r = await api.req(m, url, b.token, body);
      expect([403, 404], `${m} ${url}`).toContain(r.status);
    }
    // someone else's unattached upload cannot be claimed in a message
    const up = await upload(b, 'p.png', PNG, 'image/png');
    const r = await api.req('POST', `/channels/${ch.id}/messages`, a.token, { content: 'steal', attachments: [up.body.id] });
    expect(r.status).toBe(404);
  });
  it('malformed emoji escapes are a 400, not a 500', async () => {
    const a = await api.register('em'); const g = (await api.req('POST', '/guilds', a.token, { name: 'Emoji' })).body;
    const ch = g.channels.find((c: any) => c.type === 'text'); const m = (await api.req('POST', `/channels/${ch.id}/messages`, a.token, { content: 'hi' })).body;
    expect((await api.req('PUT', `/channels/${ch.id}/messages/${m.id}/reactions/%E0%A4%A/@me`, a.token)).status).toBe(400);
  });
  it('rate limits invite joins, invite peeks and friend-request spam', async () => {
    const lim = await startServer({ rateLimit: true }); const l = new Api(lim);
    const u = await l.register('rl');
    let join = 0; for (let i = 0; i < 22; i++) join = (await l.req('POST', '/invites/nosuchcode', u.token)).status;
    expect(join).toBe(429);
    let peek = 0; for (let i = 0; i < 62; i++) peek = (await l.req('GET', '/invites/nosuchcode', null)).status;
    expect(peek).toBe(429);
    await lim.close();
  });
});

describe('gateway limits', () => {
  it('closes oversize frames and unauthenticated op spam', async () => {
    const w = await WsClient.connect(env.port); await w.waitFor((f) => f.op === 10);
    w.send({ op: 9, d: { channelId: '1' } });
    expect((await w.waitClose()).code).toBe(4003); // anything before IDENTIFY is refused
    const big = await WsClient.connect(env.port); await big.waitFor((f) => f.op === 10);
    big.ws.send(JSON.stringify({ op: 2, d: { token: 'x'.repeat(70 * 1024) } }));
    const c = await big.waitClose(); expect([1006, 1009, 4002]).toContain(c.code);
  });
});
