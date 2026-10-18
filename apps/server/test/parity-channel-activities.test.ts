import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY_STATE_MAX_BYTES, Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('wa');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Watch Together', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const member = await api.register('wb');
  await api.req('POST', `/invites/${code}`, member.token);
  const voice = guild.channels.find((c: any) => c.type === 'voice');
  const text = guild.channels.find((c: any) => c.type === 'text');
  return { owner, guild, member, voice, text };
}

const connect = async (token: string) => { const w = await WsClient.connect(env.port); await w.identify(token); return w; };

describe('shared voice-channel activities', () => {
  it('hosts a YouTube session, syncs state through ACTIVITY_UPDATE and only fans out to channel viewers', async () => {
    const { owner, guild, member, voice } = await setup();
    const outsider = await api.register('wout');
    const wOwner = await connect(owner.token); const wMember = await connect(member.token); const wOut = await connect(outsider.token);
    const state = { videoId: 'dQw4w9WgXcQ', position: 3, playing: true };

    const created = await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'youtube', state });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ channelId: voice.id, guildId: guild.id, kind: 'youtube', hostId: owner.id, state });
    expect(created.body.startedAt).toEqual(expect.any(String));
    expect(created.body.updatedAt).toEqual(expect.any(String));
    const id = created.body.id;

    const started = await wMember.waitEvent('ACTIVITY_START', (d) => d.id === id);
    expect(started.d).toMatchObject({ channelId: voice.id, kind: 'youtube', hostId: owner.id });
    await wOwner.waitEvent('ACTIVITY_START', (d) => d.id === id);
    await wOut.expectNone((f) => f.t === 'ACTIVITY_START' && f.d.id === id);

    expect((await api.req('GET', `/channels/${voice.id}/activities`, member.token)).body.activities).toHaveLength(1);
    expect((await api.req('GET', `/activities/${id}`, member.token)).body.id).toBe(id);
    // a member who can view may not drive the session
    expect((await api.req('PATCH', `/activities/${id}/state`, member.token, { state: { ...state, playing: false } })).status).toBe(403);
    expect((await api.req('DELETE', `/activities/${id}`, member.token)).status).toBe(403);

    const updated = await api.req('PATCH', `/activities/${id}/state`, owner.token, { state: { ...state, position: 42, playing: false } });
    expect(updated.status).toBe(200);
    expect(updated.body.state).toEqual({ videoId: 'dQw4w9WgXcQ', position: 42, playing: false });
    const ev = await wMember.waitEvent('ACTIVITY_UPDATE', (d) => d.id === id && d.state.playing === false);
    expect(ev.d.state).toMatchObject({ position: 42 });
    await wOut.expectNone((f) => f.t === 'ACTIVITY_UPDATE' && f.d.id === id);

    expect((await api.req('DELETE', `/activities/${id}`, owner.token)).status).toBe(204);
    await wMember.waitEvent('ACTIVITY_END', (d) => d.id === id);
    await wOut.expectNone((f) => f.t === 'ACTIVITY_END' && f.d.id === id);
    expect((await api.req('GET', `/channels/${voice.id}/activities`, member.token)).body.activities).toEqual([]);
    wOwner.close(); wMember.close(); wOut.close();
  });

  it('rejects text channels, duplicate sessions and oversized state', async () => {
    const { owner, voice, text } = await setup();
    expect((await api.req('POST', `/channels/${text.id}/activities`, owner.token, { kind: 'youtube', state: {} })).status).toBe(400);
    const first = await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'youtube', state: { videoId: 'dQw4w9WgXcQ' } });
    expect(first.status).toBe(201);
    expect((await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'youtube', state: { videoId: 'aaaaaaaaaaa' } })).status).toBe(409);
    expect((await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'nope', state: {} })).status).toBe(400);
    expect((await api.req('PATCH', `/activities/${first.body.id}/state`, owner.token, { state: 'x'.repeat(ACTIVITY_STATE_MAX_BYTES + 1) })).status).toBe(400);
  });

  it('hides an activity from, and refuses actions by, users who cannot view its channel', async () => {
    const { owner, guild, member, voice } = await setup();
    const wMember = await connect(member.token);
    // A voice channel the plain member cannot see (VIEW_CHANNEL denied for @everyone).
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, {
      name: 'secret-voice', type: 'voice', overwrites: [{ id: guild.id, type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }],
    })).body;
    const created = await api.req('POST', `/channels/${secret.id}/activities`, owner.token, { kind: 'youtube', state: { videoId: 'dQw4w9WgXcQ' } });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // No access to the channel -> the same 404 as a missing resource, for reads and writes alike.
    expect((await api.req('GET', `/channels/${secret.id}/activities`, member.token)).status).toBe(404);
    expect((await api.req('GET', `/activities/${id}`, member.token)).status).toBe(404);
    expect((await api.req('POST', `/channels/${secret.id}/activities`, member.token, { kind: 'tictactoe', state: {} })).status).toBe(404);
    expect((await api.req('PATCH', `/activities/${id}/state`, member.token, { state: { videoId: 'aaaaaaaaaaa' } })).status).toBe(404);
    expect((await api.req('DELETE', `/activities/${id}`, member.token)).status).toBe(404);
    // And no gateway event for a channel the member cannot view.
    await wMember.expectNone((f) => f.t === 'ACTIVITY_START' && f.d.channelId === secret.id);

    // The public channel still works for the same member, so the denial is about visibility, not the member.
    expect((await api.req('GET', `/channels/${voice.id}/activities`, member.token)).status).toBe(200);
    wMember.close();
  });

  it('lets a channel viewer publish Tic-Tac-Toe moves while non-viewers can neither see nor act on the game', async () => {
    const { owner, guild, member, voice } = await setup();
    const outsider = await api.register('wout2');
    const wMember = await connect(member.token);

    const created = await api.req('POST', `/channels/${voice.id}/activities`, owner.token, {
      kind: 'tictactoe', state: { board: Array(9).fill(null), turn: 'X' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body).toMatchObject({ channelId: voice.id, kind: 'tictactoe', hostId: owner.id });

    // Either player in the call may publish a move; the turn itself is validated by the clients.
    const state = { board: ['X', null, null, null, null, null, null, null, null], turn: 'O' };
    const moved = await api.req('PATCH', `/activities/${id}/state`, member.token, { state });
    expect(moved.status).toBe(200);
    expect(moved.body.state).toEqual(state);
    // A viewer still cannot end the host's session.
    expect((await api.req('DELETE', `/activities/${id}`, member.token)).status).toBe(403);

    // A user outside the guild has no VIEW_CHANNEL: the same 404 as a missing activity, for reads and writes.
    expect((await api.req('GET', `/activities/${id}`, outsider.token)).status).toBe(404);
    expect((await api.req('PATCH', `/activities/${id}/state`, outsider.token, { state })).status).toBe(404);
    expect((await api.req('DELETE', `/activities/${id}`, outsider.token)).status).toBe(404);

    // A voice channel the plain member cannot see must not leak the board, history or live events.
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, {
      name: 'secret-game', type: 'voice', overwrites: [{ id: guild.id, type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }],
    })).body;
    const hidden = await api.req('POST', `/channels/${secret.id}/activities`, owner.token, {
      kind: 'tictactoe', state: { board: Array(9).fill(null), turn: 'X' },
    });
    expect(hidden.status).toBe(201);
    const hiddenId = hidden.body.id;

    expect((await api.req('GET', `/channels/${secret.id}/activities`, member.token)).status).toBe(404);
    expect((await api.req('GET', `/activities/${hiddenId}`, member.token)).status).toBe(404);
    expect((await api.req('PATCH', `/activities/${hiddenId}/state`, member.token, { state })).status).toBe(404);
    expect((await api.req('DELETE', `/activities/${hiddenId}`, member.token)).status).toBe(404);
    await wMember.expectNone((f) => f.t === 'ACTIVITY_START' && f.d.channelId === secret.id);
    wMember.close();
  });
});
