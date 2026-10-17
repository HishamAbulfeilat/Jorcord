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

describe('god mode', () => {
  const PW = 'correct horse battery';
  let guild: any, general: any, msgId: string;
  beforeAll(async () => {
    guild = (await api.req('POST', '/guilds', bob.token, { name: 'Bob Locked' })).body;
    general = guild.channels.find((c: any) => c.name === 'general');
    msgId = (await api.req('POST', `/channels/${general.id}/messages`, bob.token, { content: 'mine' })).body.id;
  });

  it('is off by default: the admin has no access to servers they are not in', async () => {
    expect((await api.req('GET', `/channels/${general.id}/messages`, admin.token)).status).toBe(404);
    expect((await api.req('POST', `/admin/guilds/${guild.id}/join`, admin.token)).status).toBe(400);
  });

  it('requires the password to turn on, and only the admin can turn it on', async () => {
    expect((await api.req('POST', '/admin/god-mode', admin.token, { enabled: true })).status).toBe(401);
    expect((await api.req('POST', '/admin/god-mode', admin.token, { enabled: true, password: 'wrong password!!' })).status).toBe(401);
    expect((await api.req('POST', '/admin/god-mode', alice.token, { enabled: true, password: PW })).status).toBe(404);
    const on = await api.req('POST', '/admin/god-mode', admin.token, { enabled: true, password: PW });
    expect(on.status).toBe(200); expect(Date.parse(on.body.godModeUntil)).toBeGreaterThan(Date.now());
    expect((await api.req('GET', '/admin/me', admin.token)).body.godModeUntil).toBeTruthy();
  });

  it('bypasses every permission check, even without membership', async () => {
    const r = await api.req('GET', `/channels/${general.id}/messages`, admin.token);
    expect(r.status).toBe(200); expect(r.body.map((m: any) => m.id)).toContain(msgId);
    expect((await api.req('DELETE', `/channels/${general.id}/messages/${msgId}`, admin.token)).status).toBe(204);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, admin.token, { name: 'Renamed by admin' })).status).toBe(200);
  });

  it('can join any server, then owners cannot kick, ban or re-role the admin', async () => {
    expect((await api.req('POST', `/admin/guilds/${guild.id}/join`, admin.token)).body).toMatchObject({ ok: true, joined: true });
    expect((await api.req('POST', '/admin/god-mode', admin.token, { enabled: false })).status).toBe(200);
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${admin.id}`, bob.token)).status).toBe(403);
    expect((await api.req('PUT', `/guilds/${guild.id}/bans/${admin.id}`, bob.token, {})).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${admin.id}`, bob.token, { roles: [] })).status).toBe(403);
    // bans are refused even where the admin is not a member
    const other = (await api.req('POST', '/guilds', alice.token, { name: 'Alice Two' })).body;
    expect((await api.req('PUT', `/guilds/${other.id}/bans/${admin.id}`, alice.token, {})).status).toBe(403);
  });

  it('turning it off removes the extra access, and every god-mode action is in the audit log', async () => {
    const other = (await api.req('POST', '/guilds', alice.token, { name: 'Alice Three' })).body;
    const ch = other.channels.find((c: any) => c.name === 'general');
    expect((await api.req('GET', `/channels/${ch.id}/messages`, admin.token)).status).toBe(404);
    const log = (await api.req('GET', '/admin/audit', admin.token)).body.map((e: any) => `${e.action} ${e.path}`);
    expect(log).toContain('GOD_MODE_ON /admin/god-mode');
    expect(log).toContain('GOD_MODE_OFF /admin/god-mode');
    expect(log).toContain(`DELETE /api/v1/channels/${general.id}/messages/${msgId}`);
    expect(log).toContain(`PATCH /api/v1/guilds/${guild.id}`);
  });
});
