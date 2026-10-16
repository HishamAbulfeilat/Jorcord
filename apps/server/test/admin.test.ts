import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api, admin: Client, alice: Client, bob: Client;
beforeAll(async () => {
  env = await startServer(); api = new Api(env);
  admin = await api.register('admin'); alice = await api.register('alice'); bob = await api.register('bob');
  (env.ctx.config as any).superAdminId = admin.id; // in production this comes only from SUPER_ADMIN_USER_ID
});
afterAll(async () => { await env.close(); });

describe('super admin', () => {
  it('is invisible (404) to everyone else, including guild owners', async () => {
    await api.req('POST', '/guilds', alice.token, { name: 'Alice HQ' });
    for (const url of ['/admin/me', '/admin/stats', '/admin/users', '/admin/guilds', '/admin/reports']) {
      expect((await api.req('GET', url, alice.token)).status).toBe(404);
      expect((await api.req('GET', url, null)).status).toBe(401);
    }
    expect((await api.req('POST', `/admin/users/${bob.id}/disable`, alice.token)).status).toBe(404);
  });

  it('is disabled entirely when SUPER_ADMIN_USER_ID is unset', async () => {
    (env.ctx.config as any).superAdminId = null;
    expect((await api.req('GET', '/admin/me', admin.token)).status).toBe(404);
    (env.ctx.config as any).superAdminId = admin.id;
  });

  it('sees every user, server, channel and message', async () => {
    expect((await api.req('GET', '/admin/me', admin.token)).body).toMatchObject({ admin: true, userId: admin.id });
    const stats = (await api.req('GET', '/admin/stats', admin.token)).body;
    expect(stats.users).toBeGreaterThanOrEqual(3); expect(stats.guilds).toBeGreaterThanOrEqual(1);

    const users = (await api.req('GET', `/admin/users?q=${alice.username}`, admin.token)).body;
    expect(users.map((u: any) => u.id)).toContain(alice.id);

    const guild = (await api.req('POST', '/guilds', bob.token, { name: 'Bob Private' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    await api.req('POST', `/channels/${general.id}/messages`, bob.token, { content: 'secret plans' });
    const g = (await api.req('GET', `/admin/guilds/${guild.id}`, admin.token)).body;
    expect(g.ownerId).toBe(bob.id); expect(g.members.map((m: any) => m.id)).toContain(bob.id);
    const msgs = (await api.req('GET', `/admin/channels/${general.id}/messages`, admin.token)).body;
    expect(msgs[0]).toMatchObject({ content: 'secret plans', authorId: bob.id });
    expect(Number.isNaN(Date.parse(msgs[0].createdAt))).toBe(false);
  });

  it('disables an account immediately (sessions revoked, login refused) and re-enables it', async () => {
    const victim = await api.register('victim');
    expect((await api.req('POST', `/admin/users/${victim.id}/disable`, admin.token)).status).toBe(200);
    expect((await api.req('GET', '/users/@me', victim.token)).status).toBe(401);
    const login = await api.req('POST', '/auth/login', null, { email: `${victim.username}@example.com`, password: 'correct horse battery' });
    expect(login.status).toBe(403); expect(login.body.code).toBe('ACCOUNT_DISABLED');
    expect((await api.req('POST', '/auth/refresh', null, { refreshToken: victim.refresh })).status).toBeGreaterThanOrEqual(400);

    expect((await api.req('POST', `/admin/users/${victim.id}/enable`, admin.token)).status).toBe(200);
    expect((await api.req('POST', '/auth/login', null, { email: `${victim.username}@example.com`, password: 'correct horse battery' })).status).toBe(200);
  });

  it('cannot disable the super admin account', async () => {
    expect((await api.req('POST', `/admin/users/${admin.id}/disable`, admin.token)).status).toBe(400);
    expect((await api.req('GET', '/admin/me', admin.token)).status).toBe(200);
  });
});
