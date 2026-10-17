import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

/**
 * Priority speaker is a thin authorization gate: the route only decides whether a member may enable it, and the Web
 * client sets the LiveKit attribute (the token grants canUpdateOwnMetadata). Turning it off never needs the permission.
 */
describe('priority speaker', () => {
  it('only lets a connected PRIORITY_SPEAKER holder enable it in a guild voice channel', async () => {
    const owner = await api.register('psowner');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'PS', template: 'community' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const bob = await api.register('psbob');
    await api.req('POST', `/invites/${code}`, bob.token);
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    const general = guild.channels.find((c: any) => c.type === 'text');
    const url = `/channels/${voice.id}/voice/priority-speaker`;

    // the owner holds the permission implicitly, but is not connected to the channel -> 400
    expect((await api.req('PUT', url, owner.token)).status).toBe(400);
    // a plain member lacks PRIORITY_SPEAKER -> 403 (checked before "are you connected")
    expect((await api.req('PUT', url, bob.token)).status).toBe(403);
    // an outsider cannot even see the channel -> 404
    const outsider = await api.register('psout');
    expect((await api.req('PUT', url, outsider.token)).status).toBe(404);
    // not a guild voice channel -> 400
    expect((await api.req('PUT', `/channels/${general.id}/voice/priority-speaker`, owner.token)).status).toBe(400);

    // grant PRIORITY_SPEAKER, then try while disconnected: still 400
    const r = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'speakers', permissions: String(Perm.PRIORITY_SPEAKER) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${bob.id}`, owner.token, { roles: [r.id] });
    expect((await api.req('PUT', url, bob.token)).status).toBe(400);
    // turning it off needs no permission and no connection
    expect((await api.req('DELETE', url, bob.token)).status).toBe(200);

    // join voice, then enable/disable round-trips through the gate
    const wOwner = await WsClient.connect(env.port); await wOwner.identify(owner.token);
    const wBob = await WsClient.connect(env.port); await wBob.identify(bob.token);
    wBob.send({ op: 4, d: { guildId: guild.id, channelId: voice.id } });
    await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.channelId === voice.id);

    const on = await api.req('PUT', url, bob.token);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ channelId: voice.id, prioritySpeaker: true });
    const off = await api.req('DELETE', url, bob.token);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ channelId: voice.id, prioritySpeaker: false });

    wOwner.close(); wBob.close();
  });
});
