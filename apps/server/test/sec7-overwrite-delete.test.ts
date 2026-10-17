import { Perm } from '@jorcord/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('permission overwrite delete honours the role hierarchy', () => {
  it('a manager cannot delete the overwrite of a role above them, but can for a role below', async () => {
    const owner = await api.register('o'), mod = await api.register('m');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Hier', template: 'community' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, mod.token);
    const general = guild.channels.find((c: any) => c.name === 'general');
    const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mod', permissions: String(Perm.MANAGE_ROLES | Perm.VIEW_CHANNEL) })).body;
    const high = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'High', permissions: '0' })).body;
    const low = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Low', permissions: '0' })).body;
    await api.req('PATCH', `/guilds/${guild.id}/roles`, owner.token, [{ id: high.id, position: 5 }, { id: modRole.id, position: 3 }, { id: low.id, position: 1 }]);
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${mod.id}`, owner.token, { roles: [modRole.id] })).status).toBe(200);
    for (const r of [high, low]) expect((await api.req('PUT', `/channels/${general.id}/permissions/${r.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.SEND_MESSAGES) })).status).toBe(204);
    expect((await api.req('PUT', `/channels/${general.id}/permissions/${high.id}`, mod.token, { type: 'role', allow: '0', deny: '0' })).status).toBe(403); // baseline
    expect((await api.req('DELETE', `/channels/${general.id}/permissions/${high.id}`, mod.token)).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${general.id}/permissions/${low.id}`, mod.token)).status).toBe(204);
    expect((await api.req('DELETE', `/channels/${general.id}/permissions/${high.id}`, owner.token)).status).toBe(204);
  });
});
