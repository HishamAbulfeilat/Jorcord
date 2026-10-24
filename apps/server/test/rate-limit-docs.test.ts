import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ rateLimit: true }); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('rate limit documentation endpoint and headers', () => {
  it('GET /rate-limits is public and lists global, per-route and public-page limits', async () => {
    const r = await api.req('GET', '/rate-limits', null);
    expect(r.status).toBe(200);
    expect(r.body.global.perIp.limit).toBeGreaterThan(0);
    expect(r.body.routes.some((x: any) => /POST \/api\/v1\/channels\/:id\/messages/.test(x.route) && x.limit === 10)).toBe(true);
    expect(r.body.headers).toContain('x-ratelimit-bucket');
    expect(r.raw.headers['x-ratelimit-limit']).toBeDefined();
  });
  it('every API response carries per-route X-RateLimit-* headers and a 429 adds retry-after and retry_after', async () => {
    const u = await api.register('rl');
    const first = await api.req('GET', '/users/@me', u.token);
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset-after', 'x-ratelimit-bucket']) expect(first.raw.headers[h]).toBeDefined();
    let last: any;
    for (let i = 0; i < 125; i++) last = await api.req('GET', '/users/@me', u.token);
    expect(last.status).toBe(429);
    expect(last.raw.headers['retry-after']).toBeDefined();
    expect(typeof last.body.retry_after).toBe('number');
  });
});
