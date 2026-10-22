import type { StreamInfo, VoiceState } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { publishVoice } from './voice';

/**
 * Go Live viewers. A stream is a member whose voice state has `streaming`; a viewer is a member in the same channel whose
 * `watching` is the streamer's id. The streamer may cap the audience (`streamViewerLimit`, bounded by STREAM_MAX_VIEWERS) and
 * kick viewers (stream_viewer_kicks, forgotten when the stream ends). The state lives in the voice store and is broadcast with
 * VOICE_STATE_UPDATE, so every client can render "who is watching".
 */

/** Joins and leaves of one stream are serialised on this node so two viewers cannot both take the last seat (best effort across nodes). */
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  try { return await run; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

export const effectiveLimit = (ctx: Ctx, streamer: Pick<VoiceState, 'streamViewerLimit'>) => Math.min(streamer.streamViewerLimit ?? Infinity, ctx.config.streamMaxViewers);

const kickedIds = async (ctx: Ctx, channelId: string, streamerId: string): Promise<string[]> =>
  (await ctx.db.query('SELECT user_id FROM stream_viewer_kicks WHERE channel_id = $1 AND streamer_id = $2 ORDER BY created_at', [channelId, streamerId])).map((r: any) => r.user_id);

/** Every live stream in a channel with its viewers. `kicked` is included only for streamers the caller manages (`withKicked`). */
export async function listStreams(ctx: Ctx, channelId: string, withKicked: (streamerId: string) => boolean): Promise<StreamInfo[]> {
  const states = await ctx.voice.inChannel(channelId);
  const out: StreamInfo[] = [];
  for (const s of states.filter((x) => x.streaming)) {
    const viewers = states.filter((x) => x.watching === s.userId).map((x) => x.userId);
    out.push({
      channelId, streamerId: s.userId, viewerLimit: s.streamViewerLimit ?? null, effectiveLimit: effectiveLimit(ctx, s), viewerCount: viewers.length, viewers,
      ...(withKicked(s.userId) ? { kicked: await kickedIds(ctx, channelId, s.userId) } : {}),
    });
  }
  return out;
}

async function requireHere(ctx: Ctx, userId: string, channelId: string): Promise<VoiceState> {
  const st = await ctx.voice.get(userId);
  if (!st?.channelId || st.channelId !== channelId) throw new ApiError(400, 'NOT_IN_VOICE', 'Join the voice channel first');
  return st;
}

/** The streamer sets (or clears, with null) the audience cap of their stream. Viewers already watching are not removed. */
export async function setStreamLimit(ctx: Ctx, streamerId: string, channelId: string, limit: number | null): Promise<VoiceState> {
  const st = await requireHere(ctx, streamerId, channelId);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > ctx.config.streamMaxViewers)) throw badRequest(`viewerLimit must be between 1 and ${ctx.config.streamMaxViewers}, or null`);
  if ((st.streamViewerLimit ?? null) === limit) return st;
  const next = { ...st, streamViewerLimit: limit };
  await ctx.voice.set(next);
  await publishVoice(ctx, channelId, next);
  return next;
}

/** `viewerId` starts watching `streamerId`'s stream (switching from any other stream they watched). */
export function watchStream(ctx: Ctx, viewerId: string, channelId: string, streamerId: string): Promise<VoiceState> {
  return serial(`${channelId}:${streamerId}`, async () => {
    const me = await requireHere(ctx, viewerId, channelId);
    if (viewerId === streamerId) throw badRequest('You cannot watch your own stream');
    const streamer = await ctx.voice.get(streamerId);
    if (!streamer?.streaming || streamer.channelId !== channelId) throw notFound('Stream');
    if (me.watching === streamerId) return me;
    const [kicked] = await ctx.db.query('SELECT 1 AS x FROM stream_viewer_kicks WHERE channel_id = $1 AND streamer_id = $2 AND user_id = $3', [channelId, streamerId, viewerId]);
    if (kicked) throw forbidden('You were removed from this stream', 'STREAM_VIEWER_KICKED');
    const limit = effectiveLimit(ctx, streamer);
    const watching = (await ctx.voice.inChannel(channelId)).filter((s) => s.watching === streamerId && s.userId !== viewerId).length;
    if (watching >= limit) throw new ApiError(409, 'STREAM_FULL', 'This stream has reached its viewer limit', { limit });
    const next = { ...me, watching: streamerId };
    await ctx.voice.set(next);
    await publishVoice(ctx, channelId, next);
    return next;
  });
}

/** `viewerId` stops watching whatever they watch. */
export async function stopWatching(ctx: Ctx, viewerId: string, channelId: string): Promise<VoiceState> {
  const me = await requireHere(ctx, viewerId, channelId);
  if (!me.watching) return me;
  const next = { ...me, watching: null };
  await ctx.voice.set(next);
  await publishVoice(ctx, channelId, next);
  return next;
}

/**
 * Remove a viewer from a stream and keep them out until it ends. The caller checked who may do this (the streamer, or a moderator
 * who outranks the viewer). The viewer must be in the channel; they are unsubscribed from the stream's tracks in LiveKit (best
 * effort: the streamer's client also restricts who may subscribe) and every client hears STREAM_VIEWER_KICKED.
 */
export async function kickViewer(ctx: Ctx, channelId: string, streamerId: string, targetId: string, actorId: string): Promise<void> {
  if (targetId === streamerId) throw badRequest('A streamer cannot be removed from their own stream');
  await serial(`${channelId}:${streamerId}`, async () => {
    const streamer = await ctx.voice.get(streamerId);
    if (!streamer?.streaming || streamer.channelId !== channelId) throw notFound('Stream');
    const target = await ctx.voice.get(targetId);
    if (!target?.channelId || target.channelId !== channelId) throw new ApiError(400, 'NOT_IN_VOICE', 'That member is not in this voice channel');
    await ctx.db.query(
      `INSERT INTO stream_viewer_kicks (channel_id, streamer_id, user_id, kicked_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel_id, streamer_id, user_id) DO UPDATE SET kicked_by = EXCLUDED.kicked_by`, [channelId, streamerId, targetId, actorId]);
    if (target.watching === streamerId) {
      const next = { ...target, watching: null };
      await ctx.voice.set(next);
      await publishVoice(ctx, channelId, next);
    }
  });
  await ctx.livekit.unsubscribeScreen(channelId, targetId, streamerId);
  await ctx.hub.toChannel(channelId, 'STREAM_VIEWER_KICKED', { channelId, streamerId, userId: targetId, kicked: true });
}

/** Let a kicked viewer back in (they still have to press Watch). Returns whether they had been kicked. */
export async function readmitViewer(ctx: Ctx, channelId: string, streamerId: string, targetId: string): Promise<boolean> {
  const gone = (await ctx.db.query('DELETE FROM stream_viewer_kicks WHERE channel_id = $1 AND streamer_id = $2 AND user_id = $3 RETURNING 1', [channelId, streamerId, targetId])).length > 0;
  if (gone) await ctx.hub.toChannel(channelId, 'STREAM_VIEWER_KICKED', { channelId, streamerId, userId: targetId, kicked: false });
  return gone;
}
