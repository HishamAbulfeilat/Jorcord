import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Inv', template: 'community' })).body;
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  const join = async (n = 'm') => {
    const u = await api.register(n);
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const r = await api.req('POST', `/invites/${code}`, u.token);
    return { u, r };
  };
  return { owner, guild, general, join };
}

describe('invite gateway events', () => {
  it('dispatches INVITE_CREATE on create and INVITE_DELETE on delete', async () => {
    const { owner, guild, general } = await setup();
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);

    const inv = await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, { channelId: general.id, maxUses: 7 });
    expect(inv.status).toBe(201);
    const created = await ws.waitEvent('INVITE_CREATE', (d) => d.code === inv.body.code);
    expect(created.d).toMatchObject({ code: inv.body.code, guildId: guild.id, channelId: general.id, inviterId: owner.id, maxUses: 7 });

    expect((await api.req('DELETE', `/invites/${inv.body.code}`, owner.token)).status).toBe(204);
    const deleted = await ws.waitEvent('INVITE_DELETE', (d) => d.code === inv.body.code);
    expect(deleted.d).toMatchObject({ code: inv.body.code, guildId: guild.id, channelId: general.id, inviterId: owner.id });

    ws.close();
  });
});

describe('vanity url', () => {
  it('requires MANAGE_GUILD and validates the code', async () => {
    const { owner, guild, join } = await setup();
    const { u } = await join();
    expect((await api.req('PATCH', `/guilds/${guild.id}/vanity-url`, u.token, { code: 'mine' })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/vanity-url`, owner.token, { code: 'ab' })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/vanity-url`, owner.token, { code: 'UPPER' })).status).toBe(400);
  });

  it('sets, announces, joins by, rejects duplicates and clears', async () => {
    const { owner, guild } = await setup();
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);

    const set = await api.req('PATCH', `/guilds/${guild.id}/vanity-url`, owner.token, { code: 'my-cool-server' });
    expect(set.status).toBe(200);
    expect(set.body.vanityUrl).toBe('my-cool-server');
    await ws.waitEvent('GUILD_UPDATE', (d) => d.id === guild.id && d.vanityUrl === 'my-cool-server');

    // another guild cannot take the same code
    const other = (await api.req('POST', '/guilds', owner.token, { name: 'Other' })).body;
    expect((await api.req('PATCH', `/guilds/${other.id}/vanity-url`, owner.token, { code: 'my-cool-server' })).status).toBe(409);

    // an outsider joins through the vanity link, not an invite code
    const outsider = await api.register('out');
    const joined = await api.req('POST', '/invites/my-cool-server', outsider.token);
    expect(joined.status).toBe(200);
    expect(joined.body.id).toBe(guild.id);

    // clearing the code removes the alias
    const cleared = await api.req('PATCH', `/guilds/${guild.id}/vanity-url`, owner.token, { code: null });
    expect(cleared.body.vanityUrl).toBeNull();
    const late = await api.register('late');
    expect((await api.req('POST', '/invites/my-cool-server', late.token)).status).toBe(404);

    ws.close();
  });
});
