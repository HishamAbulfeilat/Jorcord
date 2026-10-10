import type { StageInstance } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { audit } from './guilds';

export const stageDTO = (r: any): StageInstance => ({ id: r.id, guildId: r.guild_id, channelId: r.channel_id, topic: r.topic, privacyLevel: 2, scheduledEventId: r.scheduled_event_id ?? null, createdAt: iso(r.created_at)! });

/** Starts a stage instance (one per stage channel). Returns null when one is already live. */
export async function startStage(ctx: Ctx, o: { id: string; guildId: string; channelId: string; topic: string; createdBy: string; scheduledEventId?: string | null }): Promise<StageInstance | null> {
  const rows = await ctx.db.query(
    'INSERT INTO stage_instances (id, guild_id, channel_id, topic, scheduled_event_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (channel_id) DO NOTHING RETURNING *',
    [o.id, o.guildId, o.channelId, o.topic, o.scheduledEventId ?? null, o.createdBy]);
  if (!rows.length) return null;
  const dto = stageDTO(rows[0]);
  await ctx.hub.toChannel(o.channelId, 'STAGE_INSTANCE_CREATE', dto);
  await audit(ctx, o.guildId, o.createdBy, 'STAGE_INSTANCE_CREATE', o.id, { channelId: o.channelId, topic: o.topic });
  return dto;
}

export async function endStage(ctx: Ctx, channelId: string, actorId: string): Promise<StageInstance | null> {
  const rows = await ctx.db.query('DELETE FROM stage_instances WHERE channel_id = $1 RETURNING *', [channelId]);
  if (!rows.length) return null;
  const dto = stageDTO(rows[0]);
  await ctx.hub.toChannel(channelId, 'STAGE_INSTANCE_DELETE', dto);
  await audit(ctx, dto.guildId, actorId, 'STAGE_INSTANCE_DELETE', dto.id, { channelId, topic: dto.topic });
  return dto;
}

/** Ends instances nobody is in anymore (older than 60s, to give the host time to join). */
export async function endEmptyStages(ctx: Ctx) {
  const rows = await ctx.db.query(`SELECT channel_id, created_by FROM stage_instances WHERE created_at < now() - interval '60 seconds'`);
  if (!rows.length) return 0;
  const occupied = new Set((await ctx.voice.all()).map((s) => s.channelId).filter(Boolean));
  let n = 0;
  for (const r of rows) if (!occupied.has(r.channel_id)) { await endStage(ctx, r.channel_id, r.created_by); n++; }
  return n;
}
