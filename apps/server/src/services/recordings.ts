import { snowflake, type VoiceRecording } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { conflict } from '../errors';

const toDTO = (r: any): VoiceRecording => ({
  id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null,
  startedBy: r.started_by, startedAt: new Date(r.started_at).toISOString(),
});

/** The recording indicator is a channel event: everyone who can view the channel (and is connected to the gateway) sees it. */
export const publishVoiceRecording = (ctx: Ctx, channelId: string, recording: VoiceRecording | null) =>
  ctx.hub.toChannel(channelId, 'VOICE_RECORDING_UPDATE', { channelId, recording });

/** Starts a recording session; the partial unique index makes "one active recording per channel" safe across nodes. */
export async function startVoiceRecording(ctx: Ctx, channelId: string, guildId: string | null, userId: string): Promise<VoiceRecording> {
  const rows = await ctx.db.query(
    `INSERT INTO voice_recordings (id, channel_id, guild_id, started_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING *`, [snowflake(), channelId, guildId, userId]);
  const row = rows[0];
  if (!row) throw conflict('This voice channel is already being recorded', 'ALREADY_RECORDING');
  const recording = toDTO(row);
  await publishVoiceRecording(ctx, channelId, recording);
  return recording;
}

/** Stops the channel's active recording and clears the indicator. */
export async function stopVoiceRecording(ctx: Ctx, channelId: string, userId: string): Promise<VoiceRecording> {
  const rows = await ctx.db.query(
    `UPDATE voice_recordings SET stopped_at = now(), stopped_by = $2
     WHERE channel_id = $1 AND stopped_at IS NULL RETURNING *`, [channelId, userId]);
  const row = rows[0];
  if (!row) throw conflict('This voice channel is not being recorded', 'NOT_RECORDING');
  await publishVoiceRecording(ctx, channelId, null);
  return toDTO(row);
}
