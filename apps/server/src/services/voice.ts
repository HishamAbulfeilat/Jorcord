import { Perm, has, type VoiceState, type VoiceStateUpdatePayload } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest } from '../errors';
import { channelAccess } from './perms';

export const VOICE_TYPES = ['voice', 'stage', 'dm', 'group_dm'];

export const emptyState = (userId: string): VoiceState => ({ userId, guildId: null, channelId: null, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false });

export async function clearVoiceState(ctx: Ctx, userId: string) {
  const prev = ctx.hub.voice.get(userId);
  if (!prev?.channelId) return;
  ctx.hub.voice.delete(userId);
  await ctx.hub.toChannel(prev.channelId, 'VOICE_STATE_UPDATE', { ...prev, channelId: null, video: false, streaming: false });
}

export async function updateVoiceState(ctx: Ctx, userId: string, p: VoiceStateUpdatePayload) {
  if (!p.channelId) return clearVoiceState(ctx, userId);
  const a = await channelAccess(ctx, userId, p.channelId);
  if (!VOICE_TYPES.includes(a.channel.type)) throw badRequest('Not a voice channel');
  if (!has(a.perms, Perm.CONNECT)) throw new ApiError(403, 'FORBIDDEN', 'Missing permissions');
  const prev = ctx.hub.voice.get(userId);
  const inChannel = prev?.channelId === p.channelId;
  if (!inChannel) {
    let n = 0; for (const s of ctx.hub.voice.values()) if (s.channelId === p.channelId) n++;
    if (n >= (a.channel.user_limit || 99)) throw new ApiError(409, 'CHANNEL_FULL', 'Voice channel is full');
  }
  const state: VoiceState = {
    userId, guildId: a.channel.guild_id ?? null, channelId: p.channelId,
    selfMute: p.selfMute ?? prev?.selfMute ?? false, selfDeaf: p.selfDeaf ?? prev?.selfDeaf ?? false,
    serverMute: inChannel ? prev!.serverMute : false, serverDeaf: inChannel ? prev!.serverDeaf : false,
    video: (p.video ?? prev?.video ?? false) && has(a.perms, Perm.STREAM),
    streaming: (p.streaming ?? prev?.streaming ?? false) && has(a.perms, Perm.STREAM),
    suppress: a.channel.type === 'stage' && !has(a.perms, Perm.MUTE_MEMBERS),
  };
  ctx.hub.voice.set(userId, state);
  if (prev?.channelId && prev.channelId !== p.channelId) await ctx.hub.toChannel(prev.channelId, 'VOICE_STATE_UPDATE', { ...prev, channelId: null, video: false, streaming: false });
  await ctx.hub.toChannel(p.channelId, 'VOICE_STATE_UPDATE', state);
}
