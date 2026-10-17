import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('information disclosure', () => {
  it('register answers identically for a taken email and a taken username', async () => {
    const u = await api.register('taken');
    const dupEmail = await api.req('POST', '/auth/register', null, { email: u.user.email, username: 'fresh_name_1', password: 'longenoughpw' });
    const dupName = await api.req('POST', '/auth/register', null, { email: 'fresh1@example.com', username: u.username, password: 'longenoughpw' });
    expect(dupEmail.status).toBe(400); expect(dupName.status).toBe(400);
    expect(dupEmail.body).toEqual(dupName.body);
    expect(dupEmail.body.message).toBe('Could not register with these details');
  });
  it('/health shows uptime and session count only to signed-in callers', async () => {
    const anon = (await env.app.inject({ method: 'GET', url: '/health' })).json();
    expect(anon).toEqual({ status: 'ok', db: expect.any(String) });
    const u = await api.register('health');
    const authed = (await env.app.inject({ method: 'GET', url: '/health', headers: { authorization: `Bearer ${u.token}` } })).json();
    expect(authed).toMatchObject({ status: 'ok', uptime: expect.any(Number), sessions: expect.any(Number) });
    const bad = (await env.app.inject({ method: 'GET', url: '/health', headers: { authorization: 'Bearer nope' } })).json();
    expect(bad).toEqual({ status: 'ok', db: expect.any(String) });
  });
});
