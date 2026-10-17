import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { LOG_REDACT, logSerializers } from '../src/lib/security';
import { isInlineType } from '../src/services/files';
import { Api, startServer, type Client, type TestEnv } from './helpers';

// Everything in here is about the *production* posture: what a deployed server must (and must not) expose.
const PROD_CORS = ['https://chat.example.org'];

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function multipart(name: string, data: Buffer, type: string) {
  const b = '----jc' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
async function upload(env: TestEnv, c: Client, name: string, data: Buffer, type: string) {
  const m = multipart(name, data, type);
  const res = await env.app.inject({ method: 'POST', url: '/api/v1/uploads', payload: m.body, headers: { ...m.headers, authorization: `Bearer ${c.token}` } });
  return { status: res.statusCode, body: res.json() };
}

describe('security headers in production', () => {
  const started: TestEnv[] = [];
  afterAll(async () => { for (const e of started) await e.close(); });

  it('sends the full hardening set and advertises HSTS when served over TLS', async () => {
    const env = await startServer({ isProd: true, publicUrl: 'https://chat.example.org', corsOrigins: PROD_CORS });
    started.push(env);
    const u = await new Api(env).register('prodh');
    const r = await env.app.inject({ method: 'GET', url: '/health' });
    const h = r.headers;
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(String(h['content-security-policy'])).toContain("default-src 'none'");
    expect(String(h['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(String(h['content-security-policy'])).toContain("base-uri 'none'");
    // HSTS is only safe when the app is actually reachable over https.
    expect(String(h['strict-transport-security'])).toContain('max-age=15552000');
    expect(String(h['strict-transport-security'])).toContain('includeSubDomains');
    // Per-user API responses must never be cached by a shared cache.
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/users/@me', headers: { authorization: `Bearer ${u.token}` } });
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('omits HSTS on a plain-http deployment, even in production', async () => {
    const env = await startServer({ isProd: true, publicUrl: 'http://chat.example.org', corsOrigins: PROD_CORS });
    started.push(env);
    const r = await env.app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  it('never sends HSTS in development', async () => {
    const env = await startServer({ publicUrl: 'https://chat.example.org' });
    started.push(env);
    const r = await env.app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('CORS in production', () => {
  const started: TestEnv[] = [];
  afterAll(async () => { for (const e of started) await e.close(); });

  it("refuses CORS_ORIGINS='*' at startup but allows it in development", () => {
    const dir = mkdtempSync(join(tmpdir(), 'jorcord-cors-'));
    const prod = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), LIVEKIT_API_KEY: 'prodkey', LIVEKIT_API_SECRET: 'y'.repeat(40), DATA_DIR: dir };
    try {
      expect(() => loadConfig({}, { ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
      expect(() => loadConfig({}, { ...prod, CORS_ORIGINS: '' })).not.toThrow(); // unset = explicit allow-list, fine
      expect(() => loadConfig({}, { DATA_DIR: dir, CORS_ORIGINS: '*' })).not.toThrow(); // dev default
      const c = loadConfig({}, { ...prod, PUBLIC_URL: 'https://chat.example.org' });
      expect(c.corsOrigins).not.toBe(true);
      expect(c.corsOrigins).toContain('https://chat.example.org');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('allows only the configured web origin in production', async () => {
    const env = await startServer({ isProd: true, publicUrl: 'https://chat.example.org', corsOrigins: PROD_CORS });
    started.push(env);
    const preflight = (origin: string) => env.app.inject({ method: 'OPTIONS', url: '/api/v1/users/@me', headers: { origin, 'access-control-request-method': 'GET' } });
    expect((await preflight('https://chat.example.org')).headers['access-control-allow-origin']).toBe('https://chat.example.org');
    expect((await preflight('https://evil.test')).headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('upload limits in production', () => {
  const started: TestEnv[] = [];
  afterAll(async () => { for (const e of started) await e.close(); });

  it('rejects an oversize upload with 413 and keeps the configured cap', async () => {
    const env = await startServer({ isProd: true, publicUrl: 'https://chat.example.org', corsOrigins: PROD_CORS, maxUploadBytes: 1000 });
    started.push(env);
    const c = await new Api(env).register('produp');
    const r = await upload(env, c, 'big.bin', Buffer.alloc(5000, 1), 'application/octet-stream');
    expect(r.status).toBe(413);
    expect(['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE']).toContain(r.body?.code);
    // a file within the cap still succeeds
    const ok = await upload(env, c, 'ok.png', PNG, 'image/png');
    expect(ok.status).toBe(201);
    expect(ok.body.contentType).toBe('image/png');
  });

  it('only ever renders a safe allow-list of types inline', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac', 'audio/mp4']) expect(isInlineType(t), t).toBe(true);
    // active types that can execute script in the browser context must never be inline
    for (const t of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript', 'application/javascript', 'application/octet-stream']) expect(isInlineType(t), t).toBe(false);
  });
});

describe('production error responses', () => {
  it('returns a generic 500 with no stack trace or secret, but keeps informative 4xx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jorcord-err-'));
    const { app } = await buildApp({
      memoryDb: true,
      config: { logLevel: 'silent', dataDir: dir, jwtSecret: 'test-secret-test-secret-123456', rateLimit: false, unfurlOnSend: false, livekitControl: false, voiceGraceMs: 0, isProd: true, publicUrl: 'https://chat.example.org', corsOrigins: PROD_CORS } as any,
    });
    try {
      const SECRET = 'super-secret-database-password';
      app.get('/api/v1/__boom', async () => { const e: any = new Error(`connection failed for ${SECRET}`); e.stack = `Error: ${SECRET}\n    at handler`; throw e; });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/v1/__boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain('at handler');
      expect(res.body).not.toContain('stack');

      // client errors stay honest: an unknown route is a described 404, not a generic 500
      const missing = await app.inject({ method: 'GET', url: '/api/v1/definitely-not-a-route' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ code: 'NOT_FOUND', message: 'Route not found' });
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('log redaction', () => {
  it('never writes tokens, cookies or database error details to the log', async () => {
    const TOKEN = 'SUPER_SECRET_TOKEN_VALUE';
    const COOKIE = 'COOKIE_SECRET_VALUE';
    const SET_COOKIE = 'SET_COOKIE_SECRET_VALUE';
    const DB_PASSWORD = 'DB_PASSWORD_SECRET_VALUE';

    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const app = Fastify({ logger: { level: 'info', redact: LOG_REDACT, serializers: logSerializers, stream: dest } });
    try {
      app.log.info({
        req: { method: 'GET', url: `/api/v1/thing?token=${TOKEN}`, host: 'chat.example.org', ip: '203.0.113.7', socket: { remotePort: 51234 }, headers: { authorization: `Bearer ${TOKEN}`, cookie: `sid=${COOKIE}` } },
      }, 'incoming request');
      app.log.info({ res: { headers: { 'set-cookie': `sid=${SET_COOKIE}` } } }, 'response sent');
      const e: any = new Error('database failure');
      e.detail = `password=${DB_PASSWORD}`;
      e.parameters = [TOKEN];
      app.log.error({ err: e }, 'unhandled error');
    } finally { await app.close(); }

    const out = lines.join('\n');
    for (const secret of [TOKEN, COOKIE, SET_COOKIE, DB_PASSWORD]) expect(out).not.toContain(secret);
    // the request is still useful: path kept, query string (which may carry credentials) dropped
    expect(out).toContain('/api/v1/thing');
    expect(out).not.toContain('token=');
    expect(out).toContain('unhandled error');
  });
});
