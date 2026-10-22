import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserFlags, hasUserFlag, userBadges } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api, admin: Client, alice: Client, bob: Client;
beforeAll(async () => {
  env = await startServer(); api = new Api(env);
  admin = await api.register('admin'); alice = await api.register('alice'); bob = await api.register('bob');
  (env.ctx.config as any).superAdminId = admin.id;
});
afterAll(async () => { await env.close(); });

describe('user flags / badges', () => {
  it('helpers resolve badges in display order', () => {
    expect(hasUserFlag(UserFlags.STAFF | UserFlags.BUG_HUNTER, 'BUG_HUNTER')).toBe(true);
    expect(hasUserFlag(0, 'STAFF')).toBe(false);
    expect(userBadges(UserFlags.EARLY_SUPPORTER | UserFlags.STAFF).map((b) => b.flag)).toEqual(['STAFF', 'EARLY_SUPPORTER']);
    expect(userBadges(undefined)).toEqual([]);
  });

  it('only the super admin can set flags, and unknown bits are rejected', async () => {
    expect((await api.req('PATCH', `/admin/users/${alice.id}/flags`, bob.token, { flags: 1 })).status).toBe(404);
    expect((await api.req('PATCH', `/admin/users/${alice.id}/flags`, admin.token, { flags: 1 << 5 })).status).toBe(400);
    expect((await api.req('PATCH', `/admin/users/${alice.id}/flags`, admin.token, { flags: -1 })).status).toBe(400);
    expect((await api.req('PATCH', `/admin/users/${'1'.repeat(18)}/flags`, admin.token, { flags: 1 })).status).toBe(404);
  });

  it('exposes flags on profiles, /users/@me and USER_UPDATE; the super admin is always STAFF', async () => {
    expect((await api.req('GET', `/users/${alice.id}`, bob.token)).body.publicFlags).toBe(0);
    const w = await WsClient.connect(env.port); await w.identify(alice.token);
    const flags = UserFlags.BUG_HUNTER | UserFlags.EARLY_SUPPORTER;
    const r = await api.req('PATCH', `/admin/users/${alice.id}/flags`, admin.token, { flags });
    expect(r.status).toBe(200); expect(r.body.publicFlags).toBe(flags);
    expect((await w.waitEvent('USER_UPDATE', (d) => d.id === alice.id && d.publicFlags === flags)).d.id).toBe(alice.id);
    expect((await api.req('GET', `/users/${alice.id}`, bob.token)).body.publicFlags).toBe(flags);
    expect((await api.req('GET', '/users/@me', alice.token)).body.publicFlags).toBe(flags);
    expect((await api.req('GET', `/users/${admin.id}`, bob.token)).body.publicFlags & UserFlags.STAFF).toBe(UserFlags.STAFF);
    expect((await api.req('GET', `/admin/users/${alice.id}`, admin.token)).body.publicFlags).toBe(flags);
    w.close();
  });
});
