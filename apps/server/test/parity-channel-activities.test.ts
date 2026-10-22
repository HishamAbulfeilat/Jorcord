import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY_STATE_MAX_BYTES, Perm } from '@jorcord/shared';
import { emptyState } from '../src/services/voice';
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

/** Put a user in a voice channel (the shared voice store is what the server checks for participation). */
const joinVoice = async (userId: string, channel: any) => { await env.ctx.voice.set({ ...emptyState(userId), guildId: channel.guild_id ?? channel.guildId ?? null, channelId: channel.id }); };

const connect = async (token: string) => { const w = await WsClient.connect(env.port); await w.identify(token); return w; };

describe('shared voice-channel activities', () => {
  it('hosts a YouTube session, syncs state through ACTIVITY_UPDATE and only fans out to channel viewers', async () => {
    const { owner, guild, member, voice } = await setup();
    const outsider = await api.register('wout');
    const wOwner = await connect(owner.token); const wMember = await connect(member.token); const wOut = await connect(outsider.token);
    const state = { videoId: 'dQw4w9WgXcQ', position: 3, playing: true };
    await joinVoice(owner.id, voice); await joinVoice(member.id, voice);

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
    await joinVoice(owner.id, voice);
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
    await joinVoice(owner.id, secret);
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
    await joinVoice(owner.id, voice); await joinVoice(member.id, voice);

    const created = await api.req('POST', `/channels/${voice.id}/activities`, owner.token, {
      kind: 'tictactoe', state: { board: Array(9).fill(null), turn: 'X' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body).toMatchObject({ channelId: voice.id, kind: 'tictactoe', hostId: owner.id });

    // Either player in the call may publish a move; the turn itself is validated by the clients.
    // X (the host) moves first; the member is not X.
    const state = { board: ['X', null, null, null, null, null, null, null, null], turn: 'O' };
    expect((await api.req('PATCH', `/activities/${id}/state`, member.token, { state })).status).toBe(403);
    const moved = await api.req('PATCH', `/activities/${id}/state`, owner.token, { state });
    expect(moved.status).toBe(200);
    expect(moved.body.state).toMatchObject(state);
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
    await joinVoice(owner.id, secret);
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

  describe('authorization regressions', () => {
    const empty = () => Array(9).fill(null);

    it('requires being connected to the voice channel to start or change an activity', async () => {
      const { owner, member, voice } = await setup();
      // can view the channel, but is not in the call
      expect((await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'youtube', state: { videoId: 'dQw4w9WgXcQ' } })).status).toBe(403);
      await joinVoice(owner.id, voice);
      const a = await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'tictactoe' });
      expect(a.status).toBe(201);
      // the server owns the initial state: a client cannot start with a pre-played board
      expect(a.body.state).toEqual({ board: empty(), turn: 'X', o: null });
      const b = { board: ['X', ...empty().slice(1)], turn: 'O' };
      expect((await api.req('PATCH', `/activities/${a.body.id}/state`, member.token, { state: b })).status).toBe(403);
      // the host leaves the call: cannot move either
      await env.ctx.voice.set({ ...emptyState(owner.id) });
      expect((await api.req('PATCH', `/activities/${a.body.id}/state`, owner.token, { state: b })).status).toBe(403);
    });

    it('validates Tic-Tac-Toe moves on the server', async () => {
      const { owner, guild, member, voice } = await setup();
      const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
      const third = await api.register('wc');
      await joinVoice(owner.id, voice); await joinVoice(member.id, voice);
      const id = (await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'tictactoe' })).body.id;
      const patch = (u: any, board: any, turn: any) => api.req('PATCH', `/activities/${id}/state`, u.token, { state: { board, turn } });
      const at = (cells: Record<number, string>) => { const b: any[] = empty(); for (const [i, m] of Object.entries(cells)) b[+i] = m; return b; };

      expect((await patch(owner, at({ 0: 'O' }), 'X')).status).toBe(400);            // wrong mark
      expect((await patch(owner, at({ 0: 'X', 1: 'X' }), 'O')).status).toBe(400);    // two cells at once
      expect((await patch(owner, at({ 0: 'X' }), 'X')).status).toBe(400);            // turn not passed
      expect((await patch(owner, empty().slice(0, 8), 'O')).status).toBe(400);       // malformed board
      expect((await patch(member, at({ 0: 'X' }), 'O')).status).toBe(403);           // not their turn
      expect((await patch(owner, at({ 0: 'X' }), 'O')).status).toBe(200);
      expect((await patch(owner, at({ 0: 'X', 1: 'X' }), 'X')).status).toBe(403);    // X moving twice
      expect((await patch(member, at({ 0: 'O' }), 'X')).status).toBe(400);           // overwrite an occupied cell
      expect((await patch(member, at({ 0: 'X', 4: 'O' }), 'X')).status).toBe(200);   // the member claims O
      const seated = (await api.req('GET', `/activities/${id}`, member.token)).body.state;
      expect(seated.o).toBe(member.id);
      // a third person in the call cannot take over O's seat, and cannot play X
      await joinVoice(third.id, voice);
      await api.req('POST', `/invites/${code}`, third.token);
      expect((await patch(third, at({ 0: 'X', 4: 'O', 8: 'X' }), 'O')).status).toBe(403);
      expect((await patch(owner, at({ 0: 'X', 4: 'O', 1: 'X' }), 'O')).status).toBe(200);
      expect((await patch(third, at({ 0: 'X', 4: 'O', 1: 'X', 2: 'O' }), 'X')).status).toBe(403);
      // finish the game: X wins on the top row, then no further moves
      expect((await patch(member, at({ 0: 'X', 4: 'O', 1: 'X', 3: 'O' }), 'X')).status).toBe(200);
      expect((await patch(owner, at({ 0: 'X', 4: 'O', 1: 'X', 3: 'O', 2: 'X' }), 'O')).status).toBe(200);
      expect((await patch(member, at({ 0: 'X', 4: 'O', 1: 'X', 3: 'O', 2: 'X', 5: 'O' }), 'X')).status).toBe(409);
      // only a player may start a rematch
      expect((await patch(third, empty(), 'X')).status).toBe(403);
      expect((await patch(member, empty(), 'X')).status).toBe(200);
    });

    it('lets only the host or a MANAGE_CHANNELS holder end an activity', async () => {
      const { owner, guild, member, voice } = await setup();
      const mod = await api.register('wmod');
      const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
      await api.req('POST', `/invites/${code}`, mod.token);
      await joinVoice(member.id, voice);
      const id = (await api.req('POST', `/channels/${voice.id}/activities`, member.token, { kind: 'youtube', state: { videoId: 'dQw4w9WgXcQ' } })).body.id;
      // a plain viewer / participant cannot end someone else's session
      expect((await api.req('DELETE', `/activities/${id}`, mod.token)).status).toBe(403);
      // the guild owner holds MANAGE_CHANNELS and may end it without being in the call
      expect((await api.req('DELETE', `/activities/${id}`, owner.token)).status).toBe(204);
      const id2 = (await api.req('POST', `/channels/${voice.id}/activities`, member.token, { kind: 'youtube', state: { videoId: 'dQw4w9WgXcQ' } })).body.id;
      expect((await api.req('DELETE', `/activities/${id2}`, member.token)).status).toBe(204);
    });

    it('rejects malformed Watch Together state', async () => {
      const { owner, voice } = await setup();
      await joinVoice(owner.id, voice);
      for (const state of [{}, { videoId: '<script>' }, { videoId: 'dQw4w9WgXcQ', extra: 1 }, { videoId: 'dQw4w9WgXcQ', position: -1 }, 'x'])
        expect((await api.req('POST', `/channels/${voice.id}/activities`, owner.token, { kind: 'youtube', state })).status).toBe(400);
    });
  });
});
