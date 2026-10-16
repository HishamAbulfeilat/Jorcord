import { describe, expect, it } from 'vitest';
import { Api, startServer } from './helpers';

describe('rate limit keying', () => {
  it('keys per-route buckets by authenticated user id: one bucket across sessions of the same user, isolated per user', async () => {
    const env = await startServer({ rateLimit: true });
    try {
      const a = new Api(env);
      const u = await a.register('ru');
      const r1 = await a.req('GET', '/users/@me', u.token);
      expect(r1.raw.headers['x-ratelimit-remaining']).toBe('119');
      // a second credential for the same user (fresh session via login) continues the same bucket
      const login = await a.req('POST', '/auth/login', null, { email: `${u.username}@example.com`, password: 'correct horse battery' });
      expect(login.status).toBe(200);
      const r2 = await a.req('GET', '/users/@me', login.body.accessToken as string);
      expect(r2.raw.headers['x-ratelimit-bucket']).toBe(r1.raw.headers['x-ratelimit-bucket']);
      expect(r2.raw.headers['x-ratelimit-remaining']).toBe('118');
      // another user keeps its own bucket
      const v = await a.register('rv');
      expect((await a.req('GET', '/users/@me', v.token)).raw.headers['x-ratelimit-remaining']).toBe('119');
    } finally { await env.close(); }
  });

  it('falls back to the IP for unauthenticated requests: no-token and invalid-token share one bucket', async () => {
    const env = await startServer({ rateLimit: true });
    try {
      const a = new Api(env);
      const r1 = await a.req('GET', '/users/@me', null);
      expect(r1.status).toBe(401);
      expect(r1.raw.headers['x-ratelimit-remaining']).toBe('119');
      const r2 = await a.req('GET', '/users/@me', null, undefined, { authorization: 'Bearer garbage' });
      expect(r2.status).toBe(401);
      expect(r2.raw.headers['x-ratelimit-bucket']).toBe(r1.raw.headers['x-ratelimit-bucket']);
      expect(r2.raw.headers['x-ratelimit-remaining']).toBe('118');
    } finally { await env.close(); }
  });
});
