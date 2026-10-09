import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('owner'), mod = await api.register('mod'), pleb = await api.register('pleb'), outsider = await api.register('out');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Perms' })).body;
  const inv = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  for (const u of [mod, pleb]) await api.req('POST', `/invites/${inv}`, u.token);
  const general = guild.channels.find((c: any) => c.name === 'general');
  return { owner, mod, pleb, outsider, guild, general };
}

describe('permissions', () => {
  it('denies privileged actions to plain members', async () => {
    const { pleb, owner, guild, general } = await setup();
    expect((await api.req('POST', `/guilds/${guild.id}/channels`, pleb.token, { name: 'x', type: 'text' })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, pleb.token, { name: 'hax' })).status).toBe(403);
    expect((await api.req('DELETE', `/guilds/${guild.id}`, pleb.token)).status).toBe(403);
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${owner.id}`, pleb.token)).status).toBe(403);
    expect((await api.req('POST', `/guilds/${guild.id}/roles`, pleb.token, { name: 'r' })).status).toBe(403);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs`, pleb.token)).status).toBe(403);
    expect((await api.req('GET', `/guilds/${guild.id}/bans`, pleb.token)).status).toBe(403);
    expect((await api.req('PATCH', `/channels/${general.id}`, pleb.token, { name: 'z' })).status).toBe(403);
    expect((await api.req('POST', `/channels/${general.id}/messages/bulk-delete`, pleb.token, { messageIds: ['1', '2'] })).status).toBe(403);
  });

  it('mass assignment is rejected (strict schemas)', async () => {
    const { pleb, guild } = await setup();
    expect((await api.req('PATCH', '/users/@me', pleb.token, { bio: 'ok', mfaEnabled: true })).status).toBe(400);
    expect((await api.req('PATCH', '/users/@me', pleb.token, { id: '1' })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, pleb.token, { ownerId: pleb.id })).status).toBe(400);
  });

  it('non-members get 404 for everything in a guild (no IDOR)', async () => {
    const { outsider, guild, general, owner } = await setup();
    const m = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'secret' })).body;
    for (const [method, url, body] of [
      ['GET', `/guilds/${guild.id}`], ['GET', `/guilds/${guild.id}/members`], ['GET', `/guilds/${guild.id}/roles`], ['GET', `/guilds/${guild.id}/channels`],
      ['GET', `/channels/${general.id}`], ['GET', `/channels/${general.id}/messages`], ['GET', `/channels/${general.id}/pins`],
      ['POST', `/channels/${general.id}/messages`, { content: 'x' }], ['DELETE', `/channels/${general.id}/messages/${m.id}`],
      ['PUT', `/channels/${general.id}/messages/${m.id}/reactions/%F0%9F%91%8D/@me`], ['POST', `/channels/${general.id}/typing`],
      ['GET', `/guilds/${guild.id}/messages/search?q=secret`], ['POST', '/voice/token', { channelId: general.id }],
    ] as const) {
      const r = await api.req(method, url, outsider.token, body as any);
      expect([url, r.status]).toEqual([url, 404]);
    }
  });

  it('unauthenticated requests are rejected', async () => {
    expect((await api.req('GET', '/users/@me', null)).status).toBe(401);
    expect((await api.req('GET', '/users/@me', 'garbage')).status).toBe(401);
    expect((await api.req('POST', '/guilds', null, { name: 'x' })).status).toBe(401);
  });

  it('role hierarchy is enforced', async () => {
    const { owner, mod, pleb, guild } = await setup();
    const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mod', permissions: String(Perm.KICK_MEMBERS | Perm.MANAGE_ROLES | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS) })).body;
    const adminRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Admin', permissions: String(Perm.ADMINISTRATOR) })).body;
    // admin role was created later so sits above? positions: new roles are inserted at 1 so Admin is at 1, Mod pushed to 2. Put them explicitly.
    await api.req('PATCH', `/guilds/${guild.id}/roles`, owner.token, [{ id: adminRole.id, position: 5 }, { id: modRole.id, position: 3 }]);
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${mod.id}`, owner.token, { roles: [modRole.id] })).status).toBe(200);

    // mod cannot kick/ban the owner
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${owner.id}`, mod.token)).status).toBe(403);
    expect((await api.req('PUT', `/guilds/${guild.id}/bans/${owner.id}`, mod.token, {})).status).toBe(403);
    // mod cannot hand out the Admin role (above own top role) nor edit it
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${pleb.id}`, mod.token, { roles: [adminRole.id] })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${adminRole.id}`, mod.token, { name: 'pwn' })).status).toBe(403);
    // mod cannot edit own role to gain perms it lacks (escalation) or move roles above itself
    expect((await api.req('POST', `/guilds/${guild.id}/roles`, mod.token, { name: 'sneaky', permissions: String(Perm.ADMINISTRATOR) })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles`, mod.token, [{ id: modRole.id, position: 9 }])).status).toBe(403);
    // mod can give pleb the Mod role? No: equal rank is not strictly below
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${pleb.id}`, mod.token, { roles: [modRole.id] })).status).toBe(403);
    // but can kick pleb (no roles)
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${pleb.id}`, mod.token, { timeoutUntil: new Date(Date.now() + 60000).toISOString() })).status).toBe(200);
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${pleb.id}`, mod.token)).status).toBe(204);
    // audit log has entries visible to owner
    const log = await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token);
    expect(log.body.map((e: any) => e.action)).toEqual(expect.arrayContaining(['MEMBER_KICK', 'MEMBER_TIMEOUT', 'ROLE_CREATE']));
  });

  it('channel overwrites hide channels from REST and gateway', async () => {
    const { owner, pleb, guild, general } = await setup();
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, {
      name: 'staff', type: 'text', overwrites: [{ id: guild.id, type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }],
    })).body;
    expect((await api.req('GET', `/channels/${secret.id}/messages`, pleb.token)).status).toBe(404);
    expect((await api.req('GET', `/guilds/${guild.id}/channels`, pleb.token)).body.map((c: any) => c.id)).not.toContain(secret.id);
    const ws = await WsClient.connect(env.port);
    const ready = await ws.identify(pleb.token);
    expect(ready.d.guilds[0].channels.map((c: any) => c.id)).not.toContain(secret.id);
    await api.req('POST', `/channels/${secret.id}/messages`, owner.token, { content: 'staff only' });
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'public' });
    await ws.waitEvent('MESSAGE_CREATE', (d) => d.content === 'public');
    expect(ws.frames.some((f) => f.t === 'MESSAGE_CREATE' && f.d.content === 'staff only')).toBe(false);
    // member overwrite re-grants
    await api.req('PUT', `/channels/${secret.id}/permissions/${pleb.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY), deny: '0' });
    expect((await api.req('GET', `/channels/${secret.id}/messages`, pleb.token)).status).toBe(200);
    // but pleb still can't send (SEND_MESSAGES comes from @everyone which is denied only VIEW; allowed) -> deny it
    await api.req('PUT', `/channels/${secret.id}/permissions/${pleb.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL), deny: String(Perm.SEND_MESSAGES) });
    expect((await api.req('POST', `/channels/${secret.id}/messages`, pleb.token, { content: 'nope' })).status).toBe(403);
    ws.close();
  });

  it('timed-out members cannot send', async () => {
    const { owner, pleb, guild, general } = await setup();
    await api.req('PATCH', `/guilds/${guild.id}/members/${pleb.id}`, owner.token, { timeoutUntil: new Date(Date.now() + 60000).toISOString() });
    expect((await api.req('POST', `/channels/${general.id}/messages`, pleb.token, { content: 'hi' })).status).toBe(403);
    await api.req('PATCH', `/guilds/${guild.id}/members/${pleb.id}`, owner.token, { timeoutUntil: null });
    expect((await api.req('POST', `/channels/${general.id}/messages`, pleb.token, { content: 'hi' })).status).toBe(201);
  });

  it('sessions: cannot revoke someone else\'s session; revoked token stops working', async () => {
    const a = await api.register('sa'), b = await api.register('sb');
    const sessB = (await api.req('GET', '/auth/sessions', b.token)).body[0];
    expect((await api.req('POST', '/auth/sessions', a.token, { sessionId: sessB.id })).status).toBe(404);
    expect((await api.req('GET', '/users/@me', b.token)).status).toBe(200);
    expect((await api.req('POST', '/auth/logout', b.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me', b.token)).status).toBe(401);
  });
});
