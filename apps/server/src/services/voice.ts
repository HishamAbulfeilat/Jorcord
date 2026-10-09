import { Perm, has, type VoiceState, type VoiceStateUpdatePayload } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden } from '../errors';
import { channelAccess } from './perms';

export const VOICE_TYPES = ['voice', 'stage', 'dm', 'group_dm'];

export const emptyState = (userId: string): VoiceState => ({ userId, guildId: null, channelId: null, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false, requestToSpeakAt: null });

const leaveState = (prev: VoiceState): VoiceState => ({ ...prev, channelId: null, video: false, streaming: false, requestToSpeakAt: null });

/** Push a voice state to everyone who can see the channel. */
export const publishVoice = (ctx: Ctx, channelId: string, state: VoiceState) => ctx.hub.toChannel(channelId, 'VOICE_STATE_UPDATE', state);

export async function clearVoiceState(ctx: Ctx, userId: string) {
  const prev = await ctx.voice.get(userId);
  if (!prev?.channelId) return;
  await ctx.voice.delete(userId);
  await publishVoice(ctx, prev.channelId, leaveState(prev));
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
  if (!inChannel) {
    const n = (await ctx.voice.inChannel(p.channelId)).length;
    if (n >= (a.channel.user_limit || 99)) throw new ApiError(409, 'CHANNEL_FULL', 'Voice channel is full');
  }
  const mod = inChannel ? { mute: prev!.serverMute, deaf: prev!.serverDeaf } : await loadModeration(ctx, a.channel.guild_id ?? null, userId);
  const stage = a.channel.type === 'stage';
  const state: VoiceState = {
    userId, guildId: a.channel.guild_id ?? null, channelId: p.channelId,
    selfMute: p.selfMute ?? prev?.selfMute ?? false, selfDeaf: p.selfDeaf ?? prev?.selfDeaf ?? false,
    serverMute: mod.mute, serverDeaf: mod.deaf,
    video: (p.video ?? prev?.video ?? false) && has(a.perms, Perm.STREAM),
    streaming: (p.streaming ?? prev?.streaming ?? false) && has(a.perms, Perm.STREAM),
    // a stage speaker invited by a moderator stays unsuppressed while they toggle mute etc.
    suppress: stage && (inChannel ? prev!.suppress : !has(a.perms, Perm.MUTE_MEMBERS)),
    requestToSpeakAt: inChannel ? prev!.requestToSpeakAt ?? null : null,
  };
  await ctx.voice.set(state);
  if (prev?.channelId && prev.channelId !== p.channelId) await publishVoice(ctx, prev.channelId, leaveState(prev));
  await publishVoice(ctx, p.channelId, state);
}

/** Server-side mute/deafen: persisted on the member, applied to the live state and to LiveKit. */
export async function setServerVoiceFlags(ctx: Ctx, guildId: string, targetId: string, flags: { mute?: boolean; deaf?: boolean }): Promise<VoiceState | null> {
  if (flags.mute !== undefined) await ctx.db.query('UPDATE members SET voice_mute = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, targetId, flags.mute]);
  if (flags.deaf !== undefined) await ctx.db.query('UPDATE members SET voice_deaf = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, targetId, flags.deaf]);
  const st = await ctx.voice.get(targetId);
  if (!st?.channelId || st.guildId !== guildId) return null;
  const next: VoiceState = { ...st, serverMute: flags.mute ?? st.serverMute, serverDeaf: flags.deaf ?? st.serverDeaf };
  await ctx.voice.set(next);
  const a = await channelAccess(ctx, targetId, st.channelId, { requireView: false }).catch(() => null);
  if (a) await syncLiveKit(ctx, next, a.channel, a.perms);
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
  };
  await ctx.voice.set(next);
  await ctx.livekit.remove(st.channelId, targetId);
  await publishVoice(ctx, st.channelId, leaveState(st));
  await publishVoice(ctx, destChannelId, next);
  return next;
}

/** Stage: audience member asks for the floor. */
export async function requestToSpeak(ctx: Ctx, userId: string, channelId: string, on: boolean): Promise<VoiceState> {
  const st = await requireStageState(ctx, userId, channelId);
  if (!st.suppress) throw new ApiError(409, 'ALREADY_SPEAKER', 'You are already a speaker');
  const next = { ...st, requestToSpeakAt: on ? st.requestToSpeakAt ?? new Date().toISOString() : null };
  await ctx.voice.set(next);
  await publishVoice(ctx, channelId, next);
  return next;
}

/** Stage: moderator invites (suppress=false) or moves a speaker back to the audience (suppress=true). */
export async function setSuppressed(ctx: Ctx, targetId: string, channelId: string, suppress: boolean): Promise<VoiceState> {
  const st = await requireStageState(ctx, targetId, channelId);
  const a = await channelAccess(ctx, targetId, channelId);
  if (!suppress && !has(a.perms, Perm.SPEAK)) throw forbidden('That member is not allowed to speak in this channel', 'TARGET_CANNOT_SPEAK');
  const next = { ...st, suppress, requestToSpeakAt: null };
  await ctx.voice.set(next);
  await syncLiveKit(ctx, next, a.channel, a.perms);
  await publishVoice(ctx, channelId, next);
  return next;
}

async function requireStageState(ctx: Ctx, userId: string, channelId: string): Promise<VoiceState> {
  const st = await ctx.voice.get(userId);
  if (!st || st.channelId !== channelId) throw new ApiError(400, 'NOT_IN_VOICE', 'Member is not in this stage channel');
  return st;
}
