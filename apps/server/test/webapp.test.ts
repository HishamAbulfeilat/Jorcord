import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestEnv } from './helpers';

const HTML = { accept: 'text/html,application/xhtml+xml' };
let env: TestEnv; let web: string; let plain: TestEnv;

beforeAll(async () => {
  web = mkdtempSync(join(tmpdir(), 'jorcord-web-'));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Jorcord</title><div id="root"></div>');
  writeFileSync(join(web, 'sw.js'), 'self.addEventListener("fetch",()=>{})');
  writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"Jorcord","scope":"/"}');
  writeFileSync(join(web, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(tmpdir(), 'jorcord-secret-outside.txt'), 'top secret');
  env = await startServer({ webDist: web });
  plain = await startServer();
});
afterAll(async () => { await env.close(); await plain.close(); rmSync(web, { recursive: true, force: true }); rmSync(join(tmpdir(), 'jorcord-secret-outside.txt'), { force: true }); });

describe('web client served by the server', () => {
  it('serves index.html at / with an app-compatible CSP and no-cache', async () => {
    const r = await env.app.inject({ url: '/', headers: HTML });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('id="root"');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(r.headers['content-security-policy'])).not.toContain("default-src 'none'");
  });
  it('serves hashed assets as immutable and sw.js / manifest as revalidating, with ETag 304', async () => {
    const a = await env.app.inject({ url: '/assets/index-abc123.js' });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('text/javascript');
    expect(a.headers['cache-control']).toContain('immutable');
    const sw = await env.app.inject({ url: '/sw.js' });
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.headers['service-worker-allowed']).toBe('/');
    const m = await env.app.inject({ url: '/manifest.webmanifest' });
    expect(m.headers['content-type']).toContain('application/manifest+json');
    const again = await env.app.inject({ url: '/sw.js', headers: { 'if-none-match': String(sw.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });
  it('falls back to index.html for deep links that accept html', async () => {
    const r = await env.app.inject({ url: '/channels/123/456?x=1', headers: HTML });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="root"');
  });
  it('keeps API 404s as JSON, even for browsers', async () => {
    for (const url of ['/api/v1/nope', '/gateway/x', '/files/nope', '/oauth2/x', '/webhooks/1/2', '/health/x']) {
      const r = await env.app.inject({ url, headers: HTML });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().code).toBe('NOT_FOUND');
    }
    const r = await env.app.inject({ url: '/missing/thing' }); // not a navigation
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    const miss = await env.app.inject({ method: 'POST', url: '/channels/1', headers: HTML });
    expect(miss.statusCode).toBe(404);
  });
  it('/health and the API still work and are not cached', async () => {
    const h = await env.app.inject({ url: '/health' });
    expect(h.statusCode).toBe(200);
    expect(h.headers['cache-control']).toBe('no-store');
    expect(h.headers['content-security-policy']).toContain("default-src 'none'");
  });
  it('blocks path traversal', async () => {
    for (const url of ['/../jorcord-secret-outside.txt', '/%2e%2e/jorcord-secret-outside.txt', '/assets/..%2f..%2fjorcord-secret-outside.txt', '/..%5cjorcord-secret-outside.txt', '/%00', '/assets/%2e%2e/%2e%2e/jorcord-secret-outside.txt']) {
      const r = await env.app.inject({ url });
      expect(r.body, url).not.toContain('top secret');
      expect([200, 400, 404], url).toContain(r.statusCode);
      if (r.statusCode === 200) expect(r.body).not.toContain('top secret');
    }
    const r = await env.app.inject({ url: '/assets/..%2f..%2fjorcord-secret-outside.txt' });
    expect(r.statusCode).toBe(404);
  });
  it('without WEB_DIST the server stays API only', async () => {
    const r = await plain.app.inject({ url: '/', headers: HTML });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
  });
});
