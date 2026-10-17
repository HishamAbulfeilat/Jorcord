import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('end to end', () => {
  it('health', async () => {
    const r = await env.app.inject({ url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('ok');
  });

  it('register -> create guild -> invite join -> send message -> receive over gateway', async () => {
    const alice = await api.register('alice'), bob = await api.register('bob');
    const g = await api.req('POST', '/guilds', alice.token, { name: 'Test Guild', template: 'gaming' });
    expect(g.status).toBe(201);
    const guild = g.body;
    expect(guild.ownerId).toBe(alice.id);
    const text = guild.channels.filter((c: any) => c.type === 'text').map((c: any) => c.name);
    expect(text).toContain('general');
    expect(guild.channels.some((c: any) => c.type === 'voice')).toBe(true);
    expect(guild.channels.some((c: any) => c.type === 'category')).toBe(true);
    const general = guild.channels.find((c: any) => c.name === 'general');
    expect(guild.systemChannelId).toBe(general.id);

    // bob is not a member: cannot see the guild or channel (404, not 403)
    expect((await api.req('GET', `/guilds/${guild.id}`, bob.token)).status).toBe(404);
    expect((await api.req('GET', `/channels/${general.id}/messages`, bob.token)).status).toBe(404);

    const inv = await api.req('POST', `/guilds/${guild.id}/invites`, alice.token, {});
    expect(inv.status).toBe(201);
    const code = inv.body.code;
    expect((await api.req('GET', `/invites/${code}`, null)).body.guild.name).toBe('Test Guild');

    const bobWs = await WsClient.connect(env.port);
    const ready0 = await bobWs.identify(bob.token);
    expect(ready0.d.guilds).toHaveLength(0);

    const join = await api.req('POST', `/invites/${code}`, bob.token);
    expect(join.status).toBe(200);
    expect(join.body.id).toBe(guild.id);
    await bobWs.waitEvent('GUILD_CREATE', (d) => d.id === guild.id);

    const aliceWs = await WsClient.connect(env.port);
    const aReady = await aliceWs.identify(alice.token);
    expect(aReady.d.guilds[0].memberCount).toBe(2);
    expect(aReady.d.user.email).toContain('alice');

    const sent = await api.req('POST', `/channels/${general.id}/messages`, alice.token, { content: `hello <@${bob.id}>` });
    expect(sent.status).toBe(201);
    expect(sent.body.mentions).toEqual([bob.id]);
    const got = await bobWs.waitEvent('MESSAGE_CREATE', (d) => d.content.startsWith('hello'));
    expect(got.d.id).toBe(sent.body.id);
    expect(got.d.author.id).toBe(alice.id);
    expect(got.d.author).not.toHaveProperty('email');
    // mention count dispatched to bob
    const rs = await bobWs.waitEvent('READ_STATE_UPDATE', (d) => d.channelId === general.id);
    expect(rs.d.mentionCount).toBe(1);

    const hist = await api.req('GET', `/channels/${general.id}/messages`, bob.token);
    expect(hist.body.map((m: any) => m.id)).toContain(sent.body.id);
    // ack clears mentions
    const ack = await api.req('POST', `/channels/${general.id}/ack`, bob.token, { messageId: sent.body.id });
    expect(ack.body.mentionCount).toBe(0);
    const states = await api.req('GET', '/users/@me/read-states', bob.token);
    expect(states.body.find((s: any) => s.channelId === general.id).mentionCount).toBe(0);

    // presence: alice sees bob online
    expect(aReady.d.presences.some((p: any) => p.userId === bob.id && p.presence === 'online')).toBe(true);
    bobWs.close();
    await aliceWs.waitEvent('PRESENCE_UPDATE', (d) => d.userId === bob.id && d.presence === 'offline');
    aliceWs.close();
  });

  it('invite limits, expiry and bans', async () => {
    const owner = await api.register('own'), u1 = await api.register('u'), u2 = await api.register('u');
    const g = (await api.req('POST', '/guilds', owner.token, { name: 'Limited' })).body;
    const inv = (await api.req('POST', `/guilds/${g.id}/invites`, owner.token, { maxUses: 1 })).body;
    expect((await api.req('POST', `/invites/${inv.code}`, u1.token)).status).toBe(200);
    expect((await api.req('POST', `/invites/${inv.code}`, u2.token)).status).toBe(404); // exhausted
    // ban u1, they cannot rejoin
    const inv2 = (await api.req('POST', `/guilds/${g.id}/invites`, owner.token, {})).body;
    expect((await api.req('PUT', `/guilds/${g.id}/bans/${u1.id}`, owner.token, { reason: 'x' })).status).toBe(204);
    const rejoin = await api.req('POST', `/invites/${inv2.code}`, u1.token);
    expect(rejoin.status).toBe(403); expect(rejoin.body.code).toBe('BANNED');
    expect((await api.req('GET', `/guilds/${g.id}`, u1.token)).status).toBe(404);
    expect((await api.req('DELETE', `/guilds/${g.id}/bans/${u1.id}`, owner.token)).status).toBe(204);
    expect((await api.req('POST', `/invites/${inv2.code}`, u1.token)).status).toBe(200);
  });
});
