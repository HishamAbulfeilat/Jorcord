import type { Ctx } from '../ctx';

export const MAX_VOICE_STATUS = 500;

/** Normalise user input: strip control characters, collapse whitespace, empty -> null. */
export function cleanStatus(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

/** Persist and broadcast a voice channel status (null clears it). Returns false when nothing changed. */
export async function writeVoiceStatus(ctx: Ctx, channel: { id: string; guild_id: string | null }, status: string | null): Promise<boolean> {
  const rows = await ctx.db.query('UPDATE channels SET voice_status = $2 WHERE id = $1 AND voice_status IS DISTINCT FROM $2 RETURNING id', [channel.id, status]);
  if (!rows.length) return false;
  await ctx.pcache.invalidate({ k: 'channel', channelId: channel.id });
  await ctx.hub.toChannel(channel.id, 'CHANNEL_VOICE_STATUS_UPDATE', { guildId: channel.guild_id ?? null, channelId: channel.id, status });
  return true;
}

/** The status belongs to the people in the call: when the last one leaves it is cleared (called from every leave path and the sweeper). */
export async function clearVoiceStatusIfEmpty(ctx: Ctx, channelId: string): Promise<boolean> {
  if ((await ctx.voice.inChannel(channelId)).length) return false;
  const [c] = await ctx.db.query('SELECT id, guild_id FROM channels WHERE id = $1 AND voice_status IS NOT NULL', [channelId]);
  return c ? writeVoiceStatus(ctx, c, null) : false;
}

/** Sweeper: statuses of channels nobody is in (missed leave paths, restarts). */
export async function sweepVoiceStatuses(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<{ id: string }>('SELECT id FROM channels WHERE voice_status IS NOT NULL');
  let n = 0;
  for (const r of rows) if (await clearVoiceStatusIfEmpty(ctx, r.id)) n++;
  return n;
}
