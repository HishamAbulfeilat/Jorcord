import { snowflake, type AuditQuery } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';

/** Rows searched for free text at most: a text search never scans a whole large audit log. */
const SEARCH_WINDOW = 20_000;

/**
 * Filtered, newest-first page of a server's audit log. Every filter is optional and combines with AND: actor, action name, numeric type, target,
 * a date range, and a free-text search over the reason and the recorded changes.
 */
export async function queryAudit(ctx: Ctx, guildId: string, q: AuditQuery & { limit: number }) {
  const fromMs = q.from ? Date.parse(q.from) : NaN, toMs = q.to ? Date.parse(q.to) : NaN;
  const vals: unknown[] = [guildId, q.before ?? null, q.action ?? null, q.actorId ?? null, q.actionType ?? null, q.targetId ?? null,
    Number.isFinite(fromMs) ? snowflake(fromMs) : null, Number.isFinite(toMs) ? snowflake(toMs + 1) : null,
    Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null, Number.isFinite(toMs) ? new Date(toMs).toISOString() : null];
  const where = `guild_id = $1 AND ($2::text IS NULL OR id < $2) AND ($3::text IS NULL OR action = $3) AND ($4::text IS NULL OR actor_id = $4) AND ($5::int IS NULL OR action_type = $5)
    AND ($6::text IS NULL OR target_id = $6) AND ($7::text IS NULL OR id >= $7) AND ($8::text IS NULL OR id < $8)
    AND ($9::timestamptz IS NULL OR created_at >= $9) AND ($10::timestamptz IS NULL OR created_at <= $10)`;
  const text = q.q?.trim();
  if (!text) {
    vals.push(q.limit);
    return ctx.db.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $11`, vals);
  }
  vals.push(`%${text.replace(/[\\%_]/g, '\\$&')}%`, SEARCH_WINDOW, q.limit);
  return ctx.db.query(
    `SELECT * FROM (SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $12) w
      WHERE w.reason ILIKE $11 OR w.action ILIKE $11 OR w.changes::text ILIKE $11 OR w.diff::text ILIKE $11 ORDER BY w.id DESC LIMIT $13`, vals);
}

export const auditDTO = (r: any) => ({
  id: r.id, guildId: r.guild_id, actorId: r.actor_id, action: r.action, actionType: r.action_type ?? undefined, targetId: r.target_id ?? null,
  changes: r.changes ?? null, diff: r.diff ?? null, reason: r.reason ?? null, createdAt: iso(r.created_at),
});

/** Housekeeping: servers that set an audit retention lose older entries (in batches, so a large backlog never blocks the database). */
export async function sweepAuditRetention(ctx: Ctx) {
  await ctx.db.query(
    `DELETE FROM audit_log WHERE id IN (
       SELECT a.id FROM audit_log a JOIN guilds g ON g.id = a.guild_id
        WHERE (g.mod_settings->'retention'->>'auditDays') IS NOT NULL
          AND a.created_at < now() - ((g.mod_settings->'retention'->>'auditDays')::int * interval '1 day') LIMIT 5000)`);
}
/** Same for message edit history. */
export async function sweepEditRetention(ctx: Ctx) {
  await ctx.db.query(
    `DELETE FROM message_edits WHERE id IN (
       SELECT e.id FROM message_edits e JOIN messages m ON m.id = e.message_id JOIN guilds g ON g.id = m.guild_id
        WHERE (g.mod_settings->'retention'->>'editDays') IS NOT NULL
          AND e.edited_at < now() - ((g.mod_settings->'retention'->>'editDays')::int * interval '1 day') LIMIT 5000)`);
}
