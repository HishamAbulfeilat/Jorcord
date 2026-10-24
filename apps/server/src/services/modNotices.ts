import { snowflake, type ModNotice } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { loadModSettings } from './modSettings';

/** A member hears about a removal at most this often per server, and a server can only send this many notices per hour (a moderator cannot use it to spam someone). */
export const NOTICE_LIMITS = { perMemberPerDay: 3, perServerPerHour: 60 } as const;

export const noticeDTO = (r: any): ModNotice => ({
  id: r.id, guildId: r.guild_id, guildName: r.guild_name, kind: r.kind, reason: r.reason ?? null, moderatorId: r.moderator_id ?? null, appeal: !!r.appeal,
  until: r.until ? iso(r.until)! : null, createdAt: iso(r.created_at)!, readAt: r.read_at ? iso(r.read_at)! : null,
});

/**
 * Tells a member why they were kicked, banned or timed out and, for a ban, where to appeal (the existing appeal flow). Governed by the server's
 * `notices` setting; the moderator is named only with `showModerator`. Best effort: a refused or failed notice never blocks the moderation action.
 */
export async function sendRemovalNotice(ctx: Ctx, guildId: string, userId: string, kind: ModNotice['kind'], o: { reason?: string | null; moderatorId: string; until?: Date | string | null; notify?: boolean }): Promise<ModNotice | null> {
  if (o.notify === false) return null;
  const s = await loadModSettings(ctx, guildId);
  if (!s.notices.enabled) return null;
  const [u] = await ctx.db.query('SELECT bot FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!u || u.bot) return null;
  const [mine] = await ctx.db.query(`SELECT count(*)::int AS n FROM mod_notices WHERE user_id = $1 AND guild_id = $2 AND created_at > now() - interval '1 day'`, [userId, guildId]);
  if (mine.n >= NOTICE_LIMITS.perMemberPerDay) return null;
  const [all] = await ctx.db.query(`SELECT count(*)::int AS n FROM mod_notices WHERE guild_id = $1 AND created_at > now() - interval '1 hour'`, [guildId]);
  if (all.n >= NOTICE_LIMITS.perServerPerHour) return null;
  const [g] = await ctx.db.query('SELECT name FROM guilds WHERE id = $1', [guildId]);
  if (!g) return null;
  const [row] = await ctx.db.query(
    `INSERT INTO mod_notices (id, user_id, guild_id, guild_name, kind, reason, moderator_id, appeal, until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [snowflake(), userId, guildId, g.name, kind, o.reason?.trim().slice(0, 512) || null, s.notices.showModerator ? o.moderatorId : null, kind === 'ban' && s.notices.appealLink, o.until ?? null]);
  const dto = noticeDTO(row);
  await ctx.hub.toUser(userId, 'MOD_NOTICE', dto);
  return dto;
}

export async function listNotices(ctx: Ctx, userId: string, limit = 50): Promise<ModNotice[]> {
  return (await ctx.db.query('SELECT * FROM mod_notices WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [userId, Math.min(100, Math.max(1, limit))])).map(noticeDTO);
}

/** Housekeeping: notices are only useful for a while. */
export async function sweepNotices(ctx: Ctx) {
  await ctx.db.query(`DELETE FROM mod_notices WHERE created_at < now() - interval '90 days'`);
}
