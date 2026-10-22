import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { decodeJwt } from 'jose';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { sweepPrioritySpeakers } from '../src/services/voice';

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
    expect(on.body).toMatchObject({ channelId: voice.id, prioritySpeaker: true, voiceState: { userId: bob.id, prioritySpeaker: true } });
    const off = await api.req('DELETE', url, bob.token);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ channelId: voice.id, prioritySpeaker: false, voiceState: { userId: bob.id, prioritySpeaker: false } });

    wOwner.close(); wBob.close();
  });
});

async function setup() {
  const owner = await api.register('pso');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'PS2', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const bob = await api.register('psb'); await api.req('POST', `/invites/${code}`, bob.token);
  const carol = await api.register('psc'); await api.req('POST', `/invites/${code}`, carol.token);
  const voice = guild.channels.find((c: any) => c.type === 'voice');
  const stage = guild.channels.find((c: any) => c.type === 'stage');
  const r = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'speakers', permissions: String(Perm.PRIORITY_SPEAKER) })).body;
  await api.req('PATCH', `/guilds/${guild.id}/members/${bob.id}`, owner.token, { roles: [r.id] });
  const wOwner = await WsClient.connect(env.port); await wOwner.identify(owner.token);
  const wBob = await WsClient.connect(env.port); await wBob.identify(bob.token);
  const join = async (ch: any) => { const n = wOwner.frames.length; wBob.send({ op: 4, d: { guildId: guild.id, channelId: ch.id } }); await wOwner.waitFor((f) => wOwner.frames.indexOf(f) >= n && f.t === 'VOICE_STATE_UPDATE' && f.d.userId === bob.id && f.d.channelId === ch.id); };
  return { owner, guild, bob, carol, voice, stage, role: r, wOwner, wBob, join, url: (ch: any) => `/channels/${ch.id}/voice/priority-speaker` };
}

describe('priority speaker is enforced by the server', () => {
  it('stores the flag in the broadcast voice state and writes the LiveKit attribute itself', async () => {
    const { bob, voice, wOwner, wBob, join, url } = await setup();
    await join(voice);
    const seen = wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.prioritySpeaker === true);
    expect((await api.req('PUT', url(voice), bob.token)).status).toBe(200);
    expect((await seen).d.channelId).toBe(voice.id);
    expect(env.livekit.attributes.at(-1)).toEqual({ room: voice.id, identity: bob.id, attributes: { 'jv.priority': '1' } });
    expect((await env.ctx.voice.get(bob.id))?.prioritySpeaker).toBe(true);
    // idempotent: no extra LiveKit write for a repeated PUT
    const writes = env.livekit.attributes.length;
    expect((await api.req('PUT', url(voice), bob.token)).body.prioritySpeaker).toBe(true);
    expect(env.livekit.attributes.length).toBe(writes);
    // a re-join keeps it: the new token carries the attribute, and no token gives out the right to write attributes
    const claims: any = decodeJwt((await api.req('POST', '/voice/token', bob.token, { channelId: voice.id })).body.token);
    expect(claims.attributes).toEqual({ 'jv.priority': '1' }); expect(claims.video.canUpdateOwnMetadata).toBeFalsy();
    // off
    expect((await api.req('DELETE', url(voice), bob.token)).body.prioritySpeaker).toBe(false);
    expect(env.livekit.attributes.at(-1)!.attributes).toEqual({ 'jv.priority': '0' });
    expect((await env.ctx.voice.get(bob.id))?.prioritySpeaker).toBe(false);
    wOwner.close(); wBob.close();
  });

  it('cannot be enabled while server muted, and a server mute takes it away', async () => {
    const { owner, guild, bob, voice, wOwner, wBob, join, url } = await setup();
    await join(voice);
    expect((await api.req('PUT', url(voice), bob.token)).status).toBe(200);
    const gone = wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.serverMute === true && d.prioritySpeaker === false);
    expect((await api.req('PATCH', `/guilds/${guild.id}/voice-states/${bob.id}`, owner.token, { mute: true })).status).toBe(200);
    await gone;
    expect(env.livekit.attributes.at(-1)).toMatchObject({ identity: bob.id, attributes: { 'jv.priority': '0' } });
    const again = await api.req('PUT', url(voice), bob.token);
    expect(again.status).toBe(403); expect(again.body.code).toBe('CANNOT_SPEAK');
    await api.req('PATCH', `/guilds/${guild.id}/voice-states/${bob.id}`, owner.token, { mute: false });
    expect((await api.req('PUT', url(voice), bob.token)).status).toBe(200);
    wOwner.close(); wBob.close();
  });

  it('is dropped when the permission is removed (sweep), when leaving, and when moved', async () => {
    const { owner, guild, bob, voice, role, wOwner, wBob, join, url } = await setup();
    await join(voice);
    await api.req('PUT', url(voice), bob.token);
    // the role loses the permission: the next sweep revokes it and tells the channel
    await api.req('PATCH', `/guilds/${guild.id}/roles/${role.id}`, owner.token, { permissions: '0' });
    const revoked = wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.prioritySpeaker === false);
    expect(await sweepPrioritySpeakers(env.ctx)).toBe(1);
    await revoked;
    expect(await sweepPrioritySpeakers(env.ctx)).toBe(0);
    expect((await api.req('PUT', url(voice), bob.token)).status).toBe(403);
    // leaving and coming back starts without priority
    await api.req('PATCH', `/guilds/${guild.id}/roles/${role.id}`, owner.token, { permissions: String(Perm.PRIORITY_SPEAKER) });
    await api.req('PUT', url(voice), bob.token);
    wBob.send({ op: 4, d: { guildId: guild.id, channelId: null } });
    await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.channelId === null);
    expect((await env.ctx.voice.get(bob.id))).toBeNull();
    await join(voice);
    expect((await env.ctx.voice.get(bob.id))?.prioritySpeaker).toBe(false);
    // a moderator move starts afresh too
    await api.req('PUT', url(voice), bob.token);
    const other = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'second', type: 'voice' })).body;
    await api.req('POST', `/guilds/${guild.id}/voice-states/${bob.id}/move`, owner.token, { channelId: other.id });
    expect((await env.ctx.voice.get(bob.id))).toMatchObject({ channelId: other.id, prioritySpeaker: false });
    wOwner.close(); wBob.close();
  });

  it('on a stage only speakers can hold it, and moving back to the audience drops it', async () => {
    const { owner, bob, stage, wOwner, wBob, join, url } = await setup();
    await join(stage);
    const denied = await api.req('PUT', url(stage), bob.token); // suppressed audience member
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('CANNOT_SPEAK');
    await api.req('PUT', `/channels/${stage.id}/stage/speakers/${bob.id}`, owner.token);
    expect((await api.req('PUT', url(stage), bob.token)).status).toBe(200);
    const down = wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.suppress === true && d.prioritySpeaker === false);
    await api.req('DELETE', `/channels/${stage.id}/stage/speakers/${bob.id}`, owner.token);
    await down;
    expect(env.livekit.attributes.at(-1)).toMatchObject({ identity: bob.id, attributes: { 'jv.priority': '0' } });
    wOwner.close(); wBob.close();
  });

  it('refuses channels that are not guild voice channels and members outside the channel', async () => {
    const { guild, bob, carol, voice, url } = await setup();
    const text = guild.channels.find((c: any) => c.type === 'text');
    expect((await api.req('PUT', url(text), bob.token)).status).toBe(400);
    expect((await api.req('PUT', url(voice), carol.token)).status).toBe(403); // no PRIORITY_SPEAKER
    expect((await api.req('PUT', url(voice), null)).status).toBe(401);
  });
});
