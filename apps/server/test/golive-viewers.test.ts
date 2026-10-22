import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ streamMaxViewers: 3 }); api = new Api(env); });
afterAll(async () => { await env.close(); });

/** A voice channel with a streamer, four possible viewers and a moderator; everybody connected over the gateway. */
async function room() {
  const owner = await api.register('glo');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Live', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n: string) => { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); return u; };
  const streamer = await join('gls'); const v1 = await join('glv'); const v2 = await join('glv'); const v3 = await join('glv'); const v4 = await join('glv');
  const mod = await join('glm');
  const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'movers', permissions: String(Perm.MOVE_MEMBERS) })).body;
  await api.req('PATCH', `/guilds/${guild.id}/members/${mod.id}`, owner.token, { roles: [modRole.id] });
  const voice = guild.channels.find((c: any) => c.type === 'voice');
  const other = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'second', type: 'voice' })).body;
  const sockets = new Map<string, WsClient>();
  const sock = async (u: Client) => { if (!sockets.has(u.id)) { const w = await WsClient.connect(env.port); await w.identify(u.token); sockets.set(u.id, w); } return sockets.get(u.id)!; };
  const settle = async (u: Client, pred: (s: any) => boolean) => {
    for (let i = 0; i < 200; i++) { if (pred(await env.ctx.voice.get(u.id))) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('voice state did not settle');
  };
  const connect = async (u: Client, streaming = false) => { (await sock(u)).send({ op: 4, d: { guildId: guild.id, channelId: voice.id, streaming } }); await settle(u, (s) => s?.channelId === voice.id && !!s.streaming === streaming); };
  const stopStreaming = async (u: Client) => { (await sock(u)).send({ op: 4, d: { guildId: guild.id, channelId: voice.id, streaming: false } }); await settle(u, (s) => !s?.streaming); };
  const base = `/channels/${voice.id}/voice`;
  const watch = (u: Client, s: Client | '@me' = streamer) => api.req('PUT', `${base}/stream/${s === '@me' ? s : s.id}/watch`, u.token);
  const unwatch = (u: Client, s: Client = streamer) => api.req('DELETE', `${base}/stream/${s.id}/watch`, u.token);
  const kick = (by: Client, who: Client, s: Client | '@me' = streamer) => api.req('DELETE', `${base}/stream/${s === '@me' ? s : s.id}/viewers/${who.id}`, by.token);
  const streams = async (u: Client) => (await api.req('GET', `${base}/streams`, u.token));
  const close = () => { for (const w of sockets.values()) w.close(); };
  return { owner, guild, streamer, v1, v2, v3, v4, mod, voice, other, sock, connect, stopStreaming, base, watch, unwatch, kick, streams, close };
}

describe('Go Live viewers', () => {
  it('lists streams with their viewers, and only members connected to the channel may look', async () => {
    const r = await room();
    await r.connect(r.streamer, true); await r.connect(r.v1); await r.connect(r.v2);
    expect((await r.streams(r.v1)).body).toEqual([{ channelId: r.voice.id, streamerId: r.streamer.id, viewerLimit: null, effectiveLimit: 3, viewerCount: 0, viewers: [] }]);
    const w = await r.sock(r.v2);
    expect((await r.watch(r.v1)).body).toMatchObject({ userId: r.v1.id, watching: r.streamer.id });
    // everybody in the channel hears who watches (the "who is watching" overlay is driven by these states)
    await w.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === r.v1.id && d.watching === r.streamer.id);
    expect((await r.watch(r.v2)).status).toBe(200);
    const list = (await r.streams(r.v2)).body;
    expect(list[0]).toMatchObject({ streamerId: r.streamer.id, viewerCount: 2 });
    expect(list[0].viewers.sort()).toEqual([r.v1.id, r.v2.id].sort());
    expect(list[0].kicked).toBeUndefined(); // an ordinary viewer does not see the kick list
    // watching is idempotent, and stopping removes the viewer
    expect((await r.watch(r.v1)).status).toBe(200);
    expect((await r.streams(r.v2)).body[0].viewerCount).toBe(2);
    expect((await r.unwatch(r.v1)).body.watching).toBeNull();
    expect((await r.streams(r.v2)).body[0].viewers).toEqual([r.v2.id]);
    // not connected / not in the guild / not signed in
    expect((await r.streams(r.v3)).status).toBe(400);
    expect((await r.streams(await api.register('outsider'))).status).toBe(404);
    expect((await api.req('GET', `${r.base}/streams`, null)).status).toBe(401);
    r.close();
  });

  it('refuses to watch a stream that is not running, your own stream, or from outside the channel', async () => {
    const r = await room();
    await r.connect(r.streamer); await r.connect(r.v1);
    expect((await r.watch(r.v1)).status).toBe(404); // the streamer is not streaming
    await r.stopStreaming(r.streamer);
    await r.connect(r.streamer, true);
    expect((await r.watch(r.streamer, '@me')).status).toBe(400);
    expect((await r.watch(r.v3)).status).toBe(400); // not connected
    expect((await r.watch(r.v1, r.v2)).status).toBe(404); // v2 is not a streamer
    expect((await r.watch(r.v1)).status).toBe(200);
    r.close();
  });

  it('lets the streamer cap the audience per stream, bounded by the server cap', async () => {
    const r = await room();
    await r.connect(r.streamer, true);
    for (const v of [r.v1, r.v2, r.v3, r.v4]) await r.connect(v);
    const put = (u: Client, viewerLimit: unknown) => api.req('PUT', `${r.base}/stream`, u.token, { viewerLimit });
    // only a connected member who may stream can set it, with sane values
    expect((await put(r.v1, 2)).status).toBe(200); // v1 is connected, not streaming yet: sets a limit for its own future stream
    expect((await put(r.v1, null)).status).toBe(200);
    expect((await put(r.streamer, 0)).status).toBe(400);
    expect((await put(r.streamer, 1.5)).status).toBe(400);
    expect((await put(r.streamer, 4)).status).toBe(400); // server cap is 3
    expect((await put(r.streamer, 'many')).status).toBe(400);
    expect((await api.req('PUT', `${r.base}/stream`, r.streamer.token, { viewerLimit: 2, extra: 1 })).status).toBe(400);
    const set = await put(r.streamer, 2);
    expect(set.body).toMatchObject({ userId: r.streamer.id, streamViewerLimit: 2, streaming: true });
    expect((await r.streams(r.v1)).body[0]).toMatchObject({ viewerLimit: 2, effectiveLimit: 2 });
    // the third viewer is turned away with a clear error, and gets in when a seat frees up
    expect((await r.watch(r.v1)).status).toBe(200);
    expect((await r.watch(r.v2)).status).toBe(200);
    const full = await r.watch(r.v3);
    expect(full.status).toBe(409); expect(full.body).toMatchObject({ code: 'STREAM_FULL', details: { limit: 2 } });
    expect((await r.watch(r.v1)).status).toBe(200); // already inside: still fine
    await r.unwatch(r.v1);
    expect((await r.watch(r.v3)).status).toBe(200);
    // lowering the cap below the audience keeps everyone in but admits nobody new
    await put(r.streamer, 1);
    expect((await r.streams(r.v3)).body[0].viewerCount).toBe(2);
    expect((await r.watch(r.v4)).status).toBe(409);
    // clearing it falls back to the server cap (3): two watch now, one more fits
    await put(r.streamer, null);
    expect((await r.streams(r.v3)).body[0]).toMatchObject({ viewerLimit: null, effectiveLimit: 3 });
    expect((await r.watch(r.v4)).status).toBe(200);
    expect((await r.watch(r.v1)).status).toBe(409); // 3 watchers = the server-wide cap
    r.close();
  });

  it('lets the streamer remove a viewer until the stream ends', async () => {
    const r = await room();
    await r.connect(r.streamer, true); await r.connect(r.v1); await r.connect(r.v2);
    await r.watch(r.v1); await r.watch(r.v2);
    const hear = await r.sock(r.v2);
    expect((await r.kick(r.v2, r.v1)).status).toBe(403); // a viewer cannot remove another viewer
    expect((await r.kick(r.streamer, r.streamer, '@me')).status).toBe(400); // nor the streamer themself
    expect((await r.kick(r.streamer, r.v3, '@me')).status).toBe(400); // not connected
    expect((await r.kick(r.streamer, r.v1, '@me')).status).toBe(204);
    // the channel hears it, the viewer is no longer counted, LiveKit is told to drop their subscription
    const ev = await hear.waitEvent('STREAM_VIEWER_KICKED', (d) => d.userId === r.v1.id);
    expect(ev.d).toEqual({ channelId: r.voice.id, streamerId: r.streamer.id, userId: r.v1.id, kicked: true });
    expect((await env.ctx.voice.get(r.v1.id))?.watching).toBeNull();
    expect(env.livekit.unsubscribed.at(-1)).toEqual({ room: r.voice.id, viewer: r.v1.id, publisher: r.streamer.id });
    // they cannot come back, however often they try; the streamer (and moderators) see the kick list, others do not
    const back = await r.watch(r.v1);
    expect(back.status).toBe(403); expect(back.body.code).toBe('STREAM_VIEWER_KICKED');
    expect((await r.streams(r.streamer)).body[0]).toMatchObject({ viewerCount: 1, kicked: [r.v1.id] });
    expect((await r.streams(r.mod)).status).toBe(400); // moderators must be connected to look, too
    await r.connect(r.mod);
    expect((await r.streams(r.mod)).body[0].kicked).toEqual([r.v1.id]);
    expect((await r.streams(r.v2)).body[0].kicked).toBeUndefined();
    // let back in: allowed again (and told so)
    expect((await r.unwatch(r.v1)).status).toBe(200);
    expect((await api.req('DELETE', `${r.base}/stream/${r.streamer.id}/kicks/${r.v1.id}`, r.v2.token)).status).toBe(403);
    expect((await api.req('DELETE', `${r.base}/stream/@me/kicks/${r.v1.id}`, r.streamer.token)).status).toBe(204);
    expect((await api.req('DELETE', `${r.base}/stream/@me/kicks/${r.v1.id}`, r.streamer.token)).status).toBe(404);
    expect((await hear.waitEvent('STREAM_VIEWER_KICKED', (d) => d.userId === r.v1.id && d.kicked === false)).d.streamerId).toBe(r.streamer.id);
    expect((await r.watch(r.v1)).status).toBe(200);
    r.close();
  });

  it('lets a moderator with MOVE_MEMBERS remove viewers (audited), but not people who outrank them', async () => {
    const r = await room();
    await r.connect(r.streamer, true); await r.connect(r.v1); await r.connect(r.mod); await r.connect(r.owner);
    await r.watch(r.v1); await r.watch(r.owner);
    expect((await r.kick(r.v1, r.v2)).status).toBe(403); // plain member: no
    expect((await r.kick(r.mod, r.owner)).status).toBe(403); // cannot outrank the owner
    expect((await r.kick(r.mod, r.v1)).status).toBe(204);
    expect((await r.watch(r.v1)).status).toBe(403);
    expect((await env.ctx.db.query("SELECT 1 FROM audit_log WHERE guild_id = $1 AND action = 'STREAM_VIEWER_KICK' AND target_id = $2 AND actor_id = $3 AND action_type = 316", [r.guild.id, r.v1.id, r.mod.id])).length).toBe(1);
    // the streamer removing someone is their own stream's business and is not audited
    await r.watch(r.owner);
    expect((await r.kick(r.streamer, r.owner, '@me')).status).toBe(204);
    expect((await env.ctx.db.query("SELECT 1 FROM audit_log WHERE guild_id = $1 AND action = 'STREAM_VIEWER_KICK'", [r.guild.id])).length).toBe(1);
    // moderators can let someone back in
    expect((await api.req('DELETE', `${r.base}/stream/${r.streamer.id}/kicks/${r.v1.id}`, r.mod.token)).status).toBe(204);
    r.close();
  });

  it('forgets viewers, the cap and the kicks when the stream ends, the streamer leaves, or the streamer is moved', async () => {
    const r = await room();
    const kicks = async () => (await env.ctx.db.query('SELECT 1 FROM stream_viewer_kicks WHERE channel_id = $1', [r.voice.id])).length;
    await r.connect(r.streamer, true); await r.connect(r.v1); await r.connect(r.v2);
    await api.req('PUT', `${r.base}/stream`, r.streamer.token, { viewerLimit: 2 });
    await r.watch(r.v1); await r.kick(r.streamer, r.v2, '@me');
    expect(await kicks()).toBe(1);
    // stopping the stream: nobody watches, the cap and the kick list are gone
    await r.stopStreaming(r.streamer);
    expect((await env.ctx.voice.get(r.v1.id))?.watching).toBeNull();
    expect((await env.ctx.voice.get(r.streamer.id))?.streamViewerLimit).toBeNull();
    expect(await kicks()).toBe(0);
    // a new stream starts clean: the earlier kick is forgiven
    await r.connect(r.streamer, true);
    expect((await r.watch(r.v2)).status).toBe(200);
    // leaving ends it as well
    await r.kick(r.streamer, r.v2, '@me');
    const s = await r.sock(r.streamer);
    s.send({ op: 4, d: { guildId: r.guild.id, channelId: null } });
    await r.sock(r.v1);
    for (let i = 0; i < 200 && (await env.ctx.voice.get(r.streamer.id)); i++) await new Promise((x) => setTimeout(x, 10));
    expect(await kicks()).toBe(0);
    expect((await env.ctx.voice.get(r.v2.id))?.watching).toBeNull();
    // a moderator moving the streamer away drops their audience too
    await r.connect(r.streamer, true); await r.connect(r.v1);
    await r.watch(r.v1);
    expect((await api.req('POST', `/guilds/${r.guild.id}/voice-states/${r.streamer.id}/move`, r.owner.token, { channelId: r.other.id })).status).toBe(200);
    expect((await env.ctx.voice.get(r.v1.id))?.watching).toBeNull();
    r.close();
  });

  it('a viewer who leaves or is moved is no longer counted', async () => {
    const r = await room();
    await r.connect(r.streamer, true); await r.connect(r.v1);
    await api.req('PUT', `${r.base}/stream`, r.streamer.token, { viewerLimit: 1 });
    await r.watch(r.v1);
    expect((await api.req('POST', `/guilds/${r.guild.id}/voice-states/${r.v1.id}/move`, r.owner.token, { channelId: r.other.id })).status).toBe(200);
    expect((await env.ctx.voice.get(r.v1.id))?.watching).toBeNull();
    await r.connect(r.v2);
    expect((await r.watch(r.v2)).status).toBe(200); // the seat of the moved viewer is free again
    r.close();
  });

  it('needs the STREAM permission to set a limit, and the channel must be a voice channel', async () => {
    const r = await room();
    await r.connect(r.streamer, true);
    const everyone = (await api.req('GET', `/guilds/${r.guild.id}/roles`, r.owner.token)).body.find((x: any) => x.name === '@everyone');
    await api.req('PATCH', `/guilds/${r.guild.id}/roles/${everyone.id}`, r.owner.token, { permissions: String(BigInt(everyone.permissions) & ~Perm.STREAM) });
    await r.connect(r.v1); // joining strips video/streaming flags it may not use
    expect((await api.req('PUT', `${r.base}/stream`, r.v1.token, { viewerLimit: 2 })).status).toBe(403);
    const text = r.guild.channels.find((c: any) => c.type === 'text');
    expect((await api.req('GET', `/channels/${text.id}/voice/streams`, r.v1.token)).status).toBe(400);
    r.close();
  });
});
