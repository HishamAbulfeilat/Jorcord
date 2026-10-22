import { Perm, has, type VoiceState, type VoiceStateUpdatePayload } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden } from '../errors';
import { channelAccess } from './perms';
import { onVoiceJoined, onVoiceLeft, startRing } from './calls';
import { listHandQueue, lowerHand, markHandAway, publishHandQueue, raiseHand, restoreHand, speakerBlockReason } from './stage';

export const VOICE_TYPES = ['voice', 'stage', 'dm', 'group_dm'];

export const emptyState = (userId: string): VoiceState => ({ userId, guildId: null, channelId: null, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false, requestToSpeakAt: null, watching: null, streamViewerLimit: null, prioritySpeaker: false });

const leaveState = (prev: VoiceState): VoiceState => ({ ...prev, channelId: null, video: false, streaming: false, requestToSpeakAt: null, watching: null, streamViewerLimit: null, prioritySpeaker: false });

/** Push a voice state to everyone who can see the channel. */
export const publishVoice = (ctx: Ctx, channelId: string, state: VoiceState) => ctx.hub.toChannel(channelId, 'VOICE_STATE_UPDATE', state);

/**
 * A Go Live stream is over (the streamer stopped, left, or was moved/disconnected): nobody is watching it any more and the
 * viewers it kicked are forgiven. Publishes each change.
 */
async function clearWatchers(ctx: Ctx, channelId: string, streamerId: string) {
  for (const s of await ctx.voice.inChannel(channelId)) {
    if (s.watching !== streamerId) continue;
    const next = { ...s, watching: null };
    await ctx.voice.set(next);
    await publishVoice(ctx, channelId, next);
  }
  await ctx.db.query('DELETE FROM stream_viewer_kicks WHERE channel_id = $1 AND streamer_id = $2', [channelId, streamerId]);
}

/** The member left a stage: their raised hand keeps its place for a short grace period (see HAND_GRACE_SECONDS). */
async function parkHand(ctx: Ctx, channelId: string, userId: string) {
  if (await markHandAway(ctx, channelId, userId)) await publishHandQueue(ctx, channelId, userId);
}

export async function clearVoiceState(ctx: Ctx, userId: string) {
  const prev = await ctx.voice.get(userId);
  if (!prev?.channelId) return;
  await ctx.voice.delete(userId);
  await publishVoice(ctx, prev.channelId, leaveState(prev));
  if (prev.streaming) await clearWatchers(ctx, prev.channelId, userId);
  await parkHand(ctx, prev.channelId, userId);
  await onVoiceLeft(ctx, userId, prev.channelId);
}

/**
 * The user's last gateway socket closed. Keep their voice state for `voiceGraceMs` so a brief reconnect (which is
 * answered by RESUME/READY and a re-announce) shows no leave+join flicker; clear it if they are still gone afterwards.
 * LiveKit's own participant_left webhook still clears it immediately when the media connection really ended.
 */
export function clearVoiceAfterGrace(ctx: Ctx, userId: string) {
  const grace = ctx.config.voiceGraceMs;
  if (grace <= 0) { void clearVoiceState(ctx, userId).catch(() => {}); return; }
  const t = setTimeout(async () => {
    try {
      if (ctx.hub.isOnline(userId) || (await ctx.presence.onlineAmong([userId])).has(userId)) return; // came back (here or on another node)
      await clearVoiceState(ctx, userId);
    } catch (e) { ctx.log.warn({ err: e }, 'voice grace cleanup failed'); }
  }, grace);
  t.unref();
}

/** Persistent per-guild server mute/deafen of a member. */
export async function loadModeration(ctx: Ctx, guildId: string | null, userId: string): Promise<{ mute: boolean; deaf: boolean }> {
  if (!guildId) return { mute: false, deaf: false };
  const [m] = await ctx.db.query('SELECT voice_mute, voice_deaf FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return { mute: !!m?.voice_mute, deaf: !!m?.voice_deaf };
}

/** What a participant may do in LiveKit given channel permissions and their server-side voice state. */
export function voiceCaps(channel: { type: string }, perms: bigint, st: Pick<VoiceState, 'serverMute' | 'serverDeaf' | 'suppress'>) {
  const stageSilenced = channel.type === 'stage' && st.suppress;
  return {
    canSpeak: has(perms, Perm.SPEAK) && !st.serverMute && !stageSilenced,
    canStream: has(perms, Perm.STREAM) && !stageSilenced,
    canSubscribe: !st.serverDeaf,
  };
}

/** Priority speaker needs PRIORITY_SPEAKER and the right to speak where the member is right now; it is dropped as soon as either goes away. */
export const holdsPriority = (wanted: boolean | undefined, perms: bigint, caps: { canSpeak: boolean }) => !!wanted && has(perms, Perm.PRIORITY_SPEAKER) && caps.canSpeak;

/** LiveKit participant attribute read by @jorcord/voice clients. Only the server writes it: tokens carry no canUpdateOwnMetadata. */
export const PRIORITY_ATTR = 'jv.priority';
export const applyPriorityAttribute = (ctx: Ctx, state: Pick<VoiceState, 'channelId' | 'userId' | 'prioritySpeaker'>) =>
  state.channelId ? ctx.livekit.setAttributes(state.channelId, state.userId, { [PRIORITY_ATTR]: state.prioritySpeaker ? '1' : '0' }) : Promise.resolve();

/** Push the participant's current capabilities to LiveKit (best effort). */
export async function syncLiveKit(ctx: Ctx, state: VoiceState, channel: { type: string }, perms: bigint) {
  if (!state.channelId) return;
  await ctx.livekit.setPermissions(state.channelId, state.userId, voiceCaps(channel, perms, state));
}

export async function updateVoiceState(ctx: Ctx, userId: string, p: VoiceStateUpdatePayload) {
  if (!p.channelId) return clearVoiceState(ctx, userId);
  const a = await channelAccess(ctx, userId, p.channelId);
  if (!VOICE_TYPES.includes(a.channel.type)) throw badRequest('Not a voice channel');
  if (!has(a.perms, Perm.CONNECT)) throw new ApiError(403, 'FORBIDDEN', 'Missing permissions');
  const prev = await ctx.voice.get(userId);
  const inChannel = prev?.channelId === p.channelId;
  let alone = false; // first person into a DM call => ring the others
  if (!inChannel && a.channel.type === 'dm') {
    const [blk] = await ctx.db.query(
      `SELECT 1 AS x FROM relationships r JOIN dm_participants p ON p.channel_id = $1 WHERE r.type = 'blocked' AND ((r.user_id = $2 AND r.other_id = p.user_id) OR (r.other_id = $2 AND r.user_id = p.user_id)) LIMIT 1`, [a.channel.id, userId]);
    if (blk) throw forbidden('You cannot call this user', 'BLOCKED');
  }
  if (!inChannel) {
    const n = (await ctx.voice.inChannel(p.channelId)).length;
    alone = n === 0;
    if (n >= (a.channel.user_limit || 99)) throw new ApiError(409, 'CHANNEL_FULL', 'Voice channel is full');
  }
  const mod = inChannel ? { mute: prev!.serverMute, deaf: prev!.serverDeaf } : await loadModeration(ctx, a.channel.guild_id ?? null, userId);
  const stage = a.channel.type === 'stage';
  // a stage speaker invited by a moderator stays unsuppressed while they toggle mute etc.
  const suppress = stage && (inChannel ? prev!.suppress : !has(a.perms, Perm.MUTE_MEMBERS));
  const caps = voiceCaps(a.channel, a.perms, { serverMute: mod.mute, serverDeaf: mod.deaf, suppress });
  const wantStream = (p.streaming ?? prev?.streaming ?? false) && has(a.perms, Perm.STREAM);
  const streamEnded = !!prev?.streaming && (!wantStream || prev.channelId !== p.channelId) && !!prev.channelId;
  // coming back to a stage within the grace period restores the raised hand (and its place in the queue)
  let hand: Awaited<ReturnType<typeof restoreHand>> = null;
  if (stage && !inChannel && suppress) {
    hand = await restoreHand(ctx, p.channelId, userId);
    if (hand && await speakerBlockReason(ctx, p.channelId, userId)) { await lowerHand(ctx, p.channelId, userId); hand = null; }
  }
  const state: VoiceState = {
    userId, guildId: a.channel.guild_id ?? null, channelId: p.channelId,
    selfMute: p.selfMute ?? prev?.selfMute ?? false, selfDeaf: p.selfDeaf ?? prev?.selfDeaf ?? false,
    serverMute: mod.mute, serverDeaf: mod.deaf,
    video: (p.video ?? prev?.video ?? false) && has(a.perms, Perm.STREAM),
    streaming: wantStream,
    suppress,
    requestToSpeakAt: inChannel ? prev!.requestToSpeakAt ?? null : hand && !hand.anonymous ? hand.raisedAt : null,
    watching: inChannel ? prev!.watching ?? null : null,
    // the cap belongs to one stream: it is forgotten when the stream ends
    streamViewerLimit: inChannel && !streamEnded ? prev!.streamViewerLimit ?? null : null,
    prioritySpeaker: inChannel ? holdsPriority(prev!.prioritySpeaker, a.perms, caps) : false,
  };
  await ctx.voice.set(state);
  if (prev?.channelId && prev.channelId !== p.channelId) await publishVoice(ctx, prev.channelId, leaveState(prev));
  await publishVoice(ctx, p.channelId, state);
  if (streamEnded) await clearWatchers(ctx, prev!.channelId!, userId);
  if (prev?.channelId && prev.channelId !== p.channelId) { await parkHand(ctx, prev.channelId, userId); await onVoiceLeft(ctx, userId, prev.channelId); }
  if (!!prev?.prioritySpeaker && !state.prioritySpeaker && inChannel) await applyPriorityAttribute(ctx, state); // permission or speaking right was lost
  if (hand) await publishHandQueue(ctx, p.channelId, userId);
  if (!inChannel) await onVoiceJoined(ctx, userId, p.channelId); // answering on this device stops the ring on the others
  if (alone && (a.channel.type === 'dm' || a.channel.type === 'group_dm')) await startRing(ctx, a.channel, userId);
}

/** Server-side mute/deafen: persisted on the member, applied to the live state and to LiveKit. */
export async function setServerVoiceFlags(ctx: Ctx, guildId: string, targetId: string, flags: { mute?: boolean; deaf?: boolean }): Promise<VoiceState | null> {
  if (flags.mute !== undefined) await ctx.db.query('UPDATE members SET voice_mute = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, targetId, flags.mute]);
  if (flags.deaf !== undefined) await ctx.db.query('UPDATE members SET voice_deaf = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, targetId, flags.deaf]);
  const st = await ctx.voice.get(targetId);
  if (!st?.channelId || st.guildId !== guildId) return null;
  let next: VoiceState = { ...st, serverMute: flags.mute ?? st.serverMute, serverDeaf: flags.deaf ?? st.serverDeaf };
  const a = await channelAccess(ctx, targetId, st.channelId, { requireView: false }).catch(() => null);
  // a server-muted member cannot hold priority speaker (nobody should be ducked for someone who cannot be heard)
  if (a) next = { ...next, prioritySpeaker: holdsPriority(next.prioritySpeaker, a.perms, voiceCaps(a.channel, a.perms, next)) };
  await ctx.voice.set(next);
  if (a) { await syncLiveKit(ctx, next, a.channel, a.perms); if (st.prioritySpeaker && !next.prioritySpeaker) await applyPriorityAttribute(ctx, next); }
  await publishVoice(ctx, st.channelId, next);
  return next;
}

/** Remove a member from voice (kick from call). */
export async function disconnectMember(ctx: Ctx, targetId: string) {
  const st = await ctx.voice.get(targetId);
  if (!st?.channelId) return null;
  await ctx.voice.delete(targetId);
  await ctx.livekit.remove(st.channelId, targetId);
  await publishVoice(ctx, st.channelId, leaveState(st));
  if (st.streaming) await clearWatchers(ctx, st.channelId, targetId);
  await parkHand(ctx, st.channelId, targetId);
  return st;
}

/** Move a member to another voice/stage channel of the same guild. The client reconnects with a fresh voice token. */
export async function moveMember(ctx: Ctx, targetId: string, destChannelId: string): Promise<VoiceState> {
  const st = await ctx.voice.get(targetId);
  if (!st?.channelId) throw new ApiError(400, 'NOT_IN_VOICE', 'Target is not connected to voice');
  if (st.channelId === destChannelId) return st;
  const dest = await channelAccess(ctx, targetId, destChannelId, { requireView: false }).catch(() => null);
  if (!dest || dest.channel.guild_id !== st.guildId || !['voice', 'stage'].includes(dest.channel.type)) throw badRequest('Destination must be a voice channel of the same server');
  if (!has(dest.perms, Perm.VIEW_CHANNEL) || !has(dest.perms, Perm.CONNECT)) throw forbidden('Target cannot connect to that channel', 'TARGET_CANNOT_CONNECT');
  const n = (await ctx.voice.inChannel(destChannelId)).length;
  if (n >= (dest.channel.user_limit || 99)) throw new ApiError(409, 'CHANNEL_FULL', 'Voice channel is full');
  const mod = await loadModeration(ctx, st.guildId, targetId);
  const next: VoiceState = {
    ...st, channelId: destChannelId, serverMute: mod.mute, serverDeaf: mod.deaf, requestToSpeakAt: null,
    suppress: dest.channel.type === 'stage' && !has(dest.perms, Perm.MUTE_MEMBERS),
    video: st.video && has(dest.perms, Perm.STREAM), streaming: st.streaming && has(dest.perms, Perm.STREAM),
    // a move starts afresh in the new room: nobody watches this member there yet, and priority speaker must be switched on again
    watching: null, streamViewerLimit: st.streaming && has(dest.perms, Perm.STREAM) ? st.streamViewerLimit ?? null : null, prioritySpeaker: false,
  };
  await ctx.voice.set(next);
  await ctx.livekit.remove(st.channelId, targetId);
  await publishVoice(ctx, st.channelId, leaveState(st));
  if (st.streaming) await clearWatchers(ctx, st.channelId, targetId);
  await parkHand(ctx, st.channelId, targetId);
  await publishVoice(ctx, destChannelId, next);
  return next;
}

/**
 * Stage: audience member asks for the floor (or lowers their hand). The hand is queued in the database, first come first served;
 * raising it again keeps the place in line. `anonymous` hides who is asking from everyone but moderators (who read the queue).
 * Members a moderator blocked, or who and the stage's host have blocked each other, cannot ask.
 */
export async function requestToSpeak(ctx: Ctx, userId: string, channelId: string, on: boolean, o: { anonymous?: boolean } = {}): Promise<VoiceState & { handPosition: number | null; anonymous: boolean }> {
  const st = await requireStageState(ctx, userId, channelId);
  if (!st.suppress) throw new ApiError(409, 'ALREADY_SPEAKER', 'You are already a speaker');
  let requestToSpeakAt: string | null = null; let anonymous = false;
  if (on) {
    if (await speakerBlockReason(ctx, channelId, userId)) throw forbidden('You cannot ask to speak on this stage', 'STAGE_SPEAKER_BLOCKED');
    anonymous = !!o.anonymous;
    const raisedAt = await raiseHand(ctx, channelId, userId, anonymous);
    requestToSpeakAt = anonymous ? null : raisedAt; // the public voice state only shows hands that are not anonymous
  } else await lowerHand(ctx, channelId, userId);
  const next = { ...st, requestToSpeakAt };
  if (next.requestToSpeakAt !== (st.requestToSpeakAt ?? null)) { await ctx.voice.set(next); await publishVoice(ctx, channelId, next); }
  const queue = await listHandQueue(ctx, channelId);
  await publishHandQueue(ctx, channelId, userId, queue);
  return { ...next, handPosition: queue.find((e) => e.userId === userId)?.position ?? null, anonymous };
}

/** Stage: moderator invites (suppress=false) or moves a speaker back to the audience (suppress=true). */
export async function setSuppressed(ctx: Ctx, targetId: string, channelId: string, suppress: boolean): Promise<VoiceState> {
  const st = await requireStageState(ctx, targetId, channelId);
  const a = await channelAccess(ctx, targetId, channelId);
  if (!suppress && !has(a.perms, Perm.SPEAK)) throw forbidden('That member is not allowed to speak in this channel', 'TARGET_CANNOT_SPEAK');
  if (!suppress && await speakerBlockReason(ctx, channelId, targetId)) throw forbidden('That member is blocked from speaking on this stage', 'STAGE_SPEAKER_BLOCKED');
  let next: VoiceState = { ...st, suppress, requestToSpeakAt: null };
  next = { ...next, prioritySpeaker: holdsPriority(next.prioritySpeaker, a.perms, voiceCaps(a.channel, a.perms, next)) };
  await ctx.voice.set(next);
  await syncLiveKit(ctx, next, a.channel, a.perms);
  if (st.prioritySpeaker && !next.prioritySpeaker) await applyPriorityAttribute(ctx, next);
  await publishVoice(ctx, channelId, next);
  if (await lowerHand(ctx, channelId, targetId) || st.requestToSpeakAt) await publishHandQueue(ctx, channelId, targetId);
  return next;
}

/**
 * Priority speaker on/off for the caller. On needs PRIORITY_SPEAKER (checked by the caller against the channel's permissions) and
 * the right to speak right now; off is always allowed. The server keeps the flag in the voice state (broadcast to the channel,
 * which is what clients duck on) and writes the LiveKit attribute `jv.priority` itself, so a member cannot grant it to themselves.
 * Returns null when turning it off for someone who is not connected.
 */
export async function setPrioritySpeaker(ctx: Ctx, userId: string, channel: { id: string; type: string }, perms: bigint, on: boolean): Promise<VoiceState | null> {
  const st = await ctx.voice.get(userId);
  const here = !!st?.channelId && st.channelId === channel.id;
  if (!on) {
    if (!here || !st!.prioritySpeaker) return here ? st : null;
  } else {
    if (!has(perms, Perm.PRIORITY_SPEAKER)) throw forbidden('Missing permissions');
    if (!here) throw badRequest('Join the channel before enabling priority speaker');
    if (st!.prioritySpeaker) return st;
    if (!voiceCaps(channel, perms, st!).canSpeak) throw forbidden('You cannot speak in this channel right now', 'CANNOT_SPEAK');
  }
  const next: VoiceState = { ...st!, prioritySpeaker: on };
  await ctx.voice.set(next);
  await applyPriorityAttribute(ctx, next);
  await publishVoice(ctx, channel.id, next);
  return next;
}

async function requireStageState(ctx: Ctx, userId: string, channelId: string): Promise<VoiceState> {
  const st = await ctx.voice.get(userId);
  if (!st || st.channelId !== channelId) throw new ApiError(400, 'NOT_IN_VOICE', 'Member is not in this stage channel');
  return st;
}

/**
 * Sweeper: priority speaker follows permissions. A role or overwrite change that removes PRIORITY_SPEAKER (or the right to speak)
 * takes effect within one sweep interval, since those changes do not touch the voice state themselves.
 */
export async function sweepPrioritySpeakers(ctx: Ctx) {
  let n = 0;
  for (const st of await ctx.voice.all()) {
    if (!st.prioritySpeaker || !st.channelId) continue;
    const a = await channelAccess(ctx, st.userId, st.channelId, { requireView: false }).catch(() => null);
    if (a && holdsPriority(true, a.perms, voiceCaps(a.channel, a.perms, st))) continue;
    const cur = await ctx.voice.get(st.userId); // may have changed while we awaited
    if (!cur?.prioritySpeaker || cur.channelId !== st.channelId) continue;
    const next = { ...cur, prioritySpeaker: false };
    await ctx.voice.set(next);
    await applyPriorityAttribute(ctx, next);
    await publishVoice(ctx, st.channelId, next);
    n++;
  }
  return n;
}
