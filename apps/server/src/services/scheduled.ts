import { ScheduledEventEntityType as ET, ScheduledEventStatus as ST, snowflake, type ScheduledEvent, type RecurrenceRule } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { audit } from './guilds';
import { endStage, startStage } from './stage';

/** Pure function: compute the next `n` occurrences from a recurrence rule and start time. */
export function nextOccurrences(rule: RecurrenceRule, start: Date, n: number): Date[] {
  const out: Date[] = [];
  let current = new Date(start.getTime());
  let generated = 0;

  const maxCount = rule.count ?? 52;
  const untilDate = rule.until ? new Date(rule.until) : null;
  const interval = Math.max(1, Math.min(12, rule.interval ?? 1));

  while (generated < n && generated < maxCount) {
    // advance to next occurrence based on frequency
    switch (rule.frequency) {
      case 'daily':
        current = new Date(current.getTime() + interval * 24 * 60 * 60 * 1000);
        break;
      case 'weekly':
        current = new Date(current.getTime() + interval * 7 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        // Add months preserving day of month (handles month-end correctly)
        current = new Date(current.getFullYear(), current.getMonth() + interval, current.getDate(), current.getHours(), current.getMinutes(), current.getSeconds());
        break;
    }

    if (untilDate && current > untilDate) break;
    out.push(new Date(current.getTime()));
    generated++;
  }

  return out;
}

export function eventDTO(r: any, userCount: number, interested?: boolean): ScheduledEvent {
  const rule = r.recurrence_rule as RecurrenceRule | null;
  const nextOccs = rule ? nextOccurrences(rule, new Date(r.scheduled_start), 5).map((d) => d.toISOString()) : undefined;
  return {
    id: r.id, guildId: r.guild_id, channelId: r.channel_id ?? null, creatorId: r.creator_id, name: r.name, description: r.description ?? null,
    scheduledStartTime: iso(r.scheduled_start)!, scheduledEndTime: iso(r.scheduled_end), privacyLevel: 2, status: r.status, entityType: r.entity_type,
    location: r.location ?? null, image: r.image ?? null, userCount, recurrenceRule: rule ?? null, nextOccurrences: nextOccs,
    ...(interested !== undefined ? { interested } : {}),
  };
}
export async function loadEventDTO(ctx: Ctx, row: any, viewerId?: string): Promise<ScheduledEvent> {
  const [c] = await ctx.db.query('SELECT count(*)::int AS n, bool_or(user_id = $2) AS me FROM guild_scheduled_event_users WHERE event_id = $1', [row.id, viewerId ?? '']);
  return eventDTO(row, c.n, viewerId ? !!c.me : undefined);
}

export const publishEvent = async (ctx: Ctx, name: 'GUILD_SCHEDULED_EVENT_CREATE' | 'GUILD_SCHEDULED_EVENT_UPDATE' | 'GUILD_SCHEDULED_EVENT_DELETE', row: any) =>
  ctx.hub.toGuild(row.guild_id, name, await loadEventDTO(ctx, row), row.channel_id ? { channelId: row.channel_id } : {}); // channel-bound events only reach people who can see the channel

/** SCHEDULED->ACTIVE: stage events open their stage instance. */
export async function activateEvent(ctx: Ctx, id: string, actorId: string): Promise<any | null> {
  const [r] = await ctx.db.query('UPDATE guild_scheduled_events SET status = $2 WHERE id = $1 AND status = $3 RETURNING *', [id, ST.ACTIVE, ST.SCHEDULED]);
  if (!r) return null;
  if (r.entity_type === ET.STAGE_INSTANCE && r.channel_id) {
    const sid = snowflake();
    if (await startStage(ctx, { id: sid, guildId: r.guild_id, channelId: r.channel_id, topic: r.name.slice(0, 120), createdBy: r.creator_id, scheduledEventId: r.id })) await ctx.db.query('UPDATE guild_scheduled_events SET stage_instance_id = $2 WHERE id = $1', [r.id, sid]);
  }
  await publishEvent(ctx, 'GUILD_SCHEDULED_EVENT_UPDATE', r);
  await audit(ctx, r.guild_id, actorId, 'GUILD_SCHEDULED_EVENT_UPDATE', r.id, { status: ST.ACTIVE });
  return r;
}
/** ACTIVE->COMPLETED or SCHEDULED->CANCELED (the only legal terminal transitions). */
export async function finishEvent(ctx: Ctx, id: string, to: typeof ST.COMPLETED | typeof ST.CANCELED, actorId: string): Promise<any | null> {
  const from = to === ST.COMPLETED ? ST.ACTIVE : ST.SCHEDULED;
  const [r] = await ctx.db.query('UPDATE guild_scheduled_events SET status = $2 WHERE id = $1 AND status = $3 RETURNING *', [id, to, from]);
  if (!r) return null;
  if (r.stage_instance_id) await endStage(ctx, r.channel_id, actorId);
  await publishEvent(ctx, 'GUILD_SCHEDULED_EVENT_UPDATE', r);
  await audit(ctx, r.guild_id, actorId, 'GUILD_SCHEDULED_EVENT_UPDATE', r.id, { status: to });
  return r;
}

const STALE_ACTIVE_MS = 24 * 3600_000;
/** Time-driven lifecycle. All transitions are atomic UPDATEs, so several nodes sweeping at once is safe. */
export async function sweepEvents(ctx: Ctx) {
  for (const r of await ctx.db.query('SELECT id, creator_id, scheduled_end FROM guild_scheduled_events WHERE status = $1 AND scheduled_start <= now() LIMIT 200', [ST.SCHEDULED])) await activateEvent(ctx, r.id, r.creator_id).catch((e) => ctx.log.warn({ err: e }, 'event start failed'));
  const done = await ctx.db.query(
    `SELECT id, creator_id FROM guild_scheduled_events WHERE status = $1 AND ((scheduled_end IS NOT NULL AND scheduled_end <= now()) OR (scheduled_end IS NULL AND scheduled_start <= $2)) LIMIT 200`, [ST.ACTIVE, new Date(Date.now() - STALE_ACTIVE_MS)]);
  for (const r of done) await finishEvent(ctx, r.id, ST.COMPLETED, r.creator_id).catch((e) => ctx.log.warn({ err: e }, 'event end failed'));
}
