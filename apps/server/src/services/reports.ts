import { Perm, REPORT_ABUSE, REPORT_TIMEOUT_MINUTES, inQuietHours, reporterThrottled, snowflake, type Attachment, type Report, type ReportAction, type ReportReason } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { iso } from '../lib/ids';
import { audit } from './guilds';
import { deleteAttachmentFiles } from './files';
import { settleLastMessage } from './messages';
import { loadModSettings } from './modSettings';
import { sendRemovalNotice } from './modNotices';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, need, needOutrankMember } from './perms';
import { memberDTO } from './serializers';
import { setSensitive } from './sensitive';

/** Label stored in the audit log instead of the reporter's id for an anonymous report. */
export const ANONYMOUS_ACTOR = 'anonymous';
const MOD_BITS = Perm.ADMINISTRATOR | Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_GUILD;

/** Members who can work the report queue (owner and roles with a moderation permission). */
export async function moderatorIds(ctx: Ctx, guildId: string): Promise<string[]> {
  const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
  const roles = (await ctx.db.query('SELECT id, permissions FROM roles WHERE guild_id = $1', [guildId])).filter((r) => (BigInt(r.permissions) & MOD_BITS) !== 0n).map((r) => r.id as string);
  const ids = new Set<string>(g ? [g.owner_id] : []);
  if (roles.length) for (const r of await ctx.db.query('SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[]) LIMIT 200', [guildId, roles])) ids.add(r.user_id);
  return [...ids];
}

/** Content-free ping to moderators who are not in their quiet hours. The queue itself still refreshes for everyone through GUILD_REPORTS_UPDATE. */
export async function notifyModerators(ctx: Ctx, guildId: string, reportId: string | null, count: number) {
  const mods = await moderatorIds(ctx, guildId);
  if (!mods.length) return;
  const prefs = new Map((await ctx.db.query('SELECT user_id, quiet_start, quiet_end, tz_offset FROM mod_prefs WHERE guild_id = $1 AND user_id = ANY($2::text[])', [guildId, mods]))
    .map((p) => [p.user_id as string, { start: p.quiet_start as number | null, end: p.quiet_end as number | null, tzOffset: p.tz_offset as number }]));
  const now = Date.now();
  const awake = mods.filter((u) => !inQuietHours(prefs.get(u), now));
  if (awake.length) await ctx.hub.toUsers(awake, 'MOD_REPORT_PING', { guildId, reportId: reportId ?? '', count });
}

export async function createReport(ctx: Ctx, userId: string, channelId: string, messageId: string, b: { reason: ReportReason; description?: string; anonymous?: boolean }): Promise<{ id: string }> {
  const a = await channelAccess(ctx, userId, channelId); // the sender must be able to see what they report
  const guildId = a.channel.guild_id as string | null;
  if (!guildId) throw badRequest('Reports are for server messages'); // DMs have no moderator queue
  const [msg] = await ctx.db.query('SELECT author_id, content, attachments FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
  if (!msg) throw notFound('Message');
  if (msg.author_id === userId) throw badRequest('You cannot report your own message');
  const dup = await ctx.db.query(`SELECT 1 AS x FROM reports WHERE message_id = $1 AND reporter_id = $2 AND status = 'open'`, [messageId, userId]);
  if (dup.length) throw new ApiError(409, 'ALREADY_REPORTED', 'You already reported this message');
  // Abuse resistance: someone whose recent reports were mostly dismissed gets a small daily allowance instead of the hourly one.
  const [st] = await ctx.db.query(
    `SELECT count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed, count(*) FILTER (WHERE status = 'resolved')::int AS resolved
       FROM reports WHERE reporter_id = $1 AND created_at > now() - ($2::int * interval '1 day')`, [userId, REPORT_ABUSE.windowDays]);
  if (reporterThrottled(st)) {
    const [today] = await ctx.db.query(`SELECT count(*)::int AS n FROM reports WHERE reporter_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
    if (today.n >= REPORT_ABUSE.throttledPerDay) throw new ApiError(429, 'REPORT_THROTTLED', 'Most of your recent reports were dismissed. Try again tomorrow, or message a moderator directly.');
  }
  const [perTarget] = await ctx.db.query(`SELECT count(*)::int AS n FROM reports WHERE reporter_id = $1 AND target_user_id = $2 AND created_at > now() - interval '1 day'`, [userId, msg.author_id]);
  if (perTarget.n >= 5) throw new ApiError(429, 'REPORT_THROTTLED', 'You already reported this member several times today');
  const snapshot = { content: msg.content ?? '', attachments: msg.attachments ?? [], takenAt: new Date().toISOString() };
  const [primary] = await ctx.db.query(`SELECT id FROM reports WHERE message_id = $1 AND canonical_id IS NULL AND status = 'open' ORDER BY id LIMIT 1`, [messageId]);
  const rid = snowflake();
  await ctx.db.query(
    'INSERT INTO reports (id, guild_id, channel_id, message_id, reporter_id, target_user_id, reason, description, anonymous, snapshot, canonical_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)',
    [rid, guildId, channelId, messageId, userId, msg.author_id, b.reason, b.description ?? null, b.anonymous === true, JSON.stringify(snapshot), primary?.id ?? null]);
  await audit(ctx, guildId, b.anonymous ? ANONYMOUS_ACTOR : userId, 'REPORT_CREATE', messageId, { reason: b.reason, channelId, targetUserId: msg.author_id, ...(primary ? { duplicateOf: primary.id } : {}) });
  await ctx.hub.toGuild(guildId, 'GUILD_REPORTS_UPDATE', { guildId });
  if (!primary) await notifyModerators(ctx, guildId, rid, 1);
  return { id: primary?.id ?? rid };
}

/** Report as moderators see it. An anonymous reporter is never exposed; duplicates are folded into `reportCount`. */
export function reportDTO(r: any, blurMedia: boolean): Report {
  const live = r.msg_content === null && r.msg_attachments === null ? null : { content: r.msg_content ?? '', attachments: r.msg_attachments };
  const snap = r.snapshot ? { content: r.snapshot.content ?? '', attachments: r.snapshot.attachments ?? [] } : live;
  return {
    id: r.id, guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id, reporterId: r.anonymous ? null : r.reporter_id, targetUserId: r.target_user_id,
    reason: r.reason as ReportReason, description: r.description ?? null,
    message: snap ? { content: snap.content, attachments: (snap.attachments ?? []) as Attachment[] } : null,
    status: r.status, handledBy: r.handled_by ?? null, handledAt: r.handled_at ? iso(r.handled_at) : null, createdAt: iso(r.created_at)!,
    reportCount: 1 + (r.dup_count ?? 0), anonymous: !!r.anonymous, actionTaken: r.action_taken ?? null, blurMedia,
  };
}
const SELECT_REPORT = `SELECT r.*, (SELECT count(*)::int FROM reports d WHERE d.canonical_id = r.id) AS dup_count, m.content AS msg_content, m.attachments AS msg_attachments
  FROM reports r LEFT JOIN messages m ON m.id = r.message_id`;

/** Whether this moderator wants media blurred in the queue: their own choice, else the server default. */
export async function blurFor(ctx: Ctx, guildId: string, userId: string): Promise<boolean> {
  const [p] = await ctx.db.query('SELECT blur_media FROM mod_prefs WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (p && typeof p.blur_media === 'boolean') return p.blur_media;
  return (await loadModSettings(ctx, guildId)).wellbeing.blurMedia;
}

export async function listReports(ctx: Ctx, guildId: string, viewerId: string, q: { status: 'open' | 'resolved' | 'dismissed' | 'all'; limit: number; before?: string }): Promise<Report[]> {
  const blur = await blurFor(ctx, guildId, viewerId);
  const rows = await ctx.db.query(`${SELECT_REPORT} WHERE r.guild_id = $1 AND r.canonical_id IS NULL AND ($2 OR r.status = $3) AND ($4::text IS NULL OR r.id < $4::text) ORDER BY r.id DESC LIMIT $5`,
    [guildId, q.status === 'all', q.status, q.before ?? null, q.limit]);
  return rows.map((r) => reportDTO(r, blur));
}
export async function getReport(ctx: Ctx, guildId: string, reportId: string, viewerId: string): Promise<Report | null> {
  const [r] = await ctx.db.query(`${SELECT_REPORT} WHERE r.guild_id = $1 AND r.id = $2`, [guildId, reportId]);
  return r ? reportDTO(r, await blurFor(ctx, guildId, viewerId)) : null;
}

/**
 * Resolve or dismiss a report (and every duplicate folded into it), optionally with a canned action. The action's own permission is checked
 * first, so a refused action leaves the report open.
 */
export async function triageReport(ctx: Ctx, actorId: string, guildId: string, reportId: string, status: 'resolved' | 'dismissed', action: ReportAction = 'none'): Promise<Report> {
  const actor = await guildAccess(ctx, actorId, guildId);
  const [rep] = await ctx.db.query('SELECT * FROM reports WHERE id = $1 AND guild_id = $2', [reportId, guildId]);
  if (!rep) throw notFound('Report');
  if (rep.canonical_id) throw notFound('Report');
  if (rep.status !== 'open') throw new ApiError(409, 'ALREADY_HANDLED', 'The report is already handled');
  if (action !== 'none' && status !== 'resolved') throw badRequest('A canned action goes with resolving a report');
  const channelAccessFor = async () => channelAccess(ctx, actorId, rep.channel_id);
  if (action === 'delete_message' || action === 'mark_sensitive') need((await channelAccessFor()).perms, Perm.MANAGE_MESSAGES);
  if (action === 'warn' || action === 'timeout') {
    need(guildPerms(actor), Perm.MODERATE_MEMBERS);
    const target = await loadGuildPerm(ctx, guildId, rep.target_user_id);
    if (!target) throw badRequest('The member already left the server');
    needOutrankMember(actor, target);
    if (rep.target_user_id === actorId) throw forbidden('You cannot take action against yourself');
  }
  const done = await ctx.db.query(
    `UPDATE reports SET status = $3, handled_by = $4, handled_at = now(), action_taken = $5 WHERE (id = $1 OR canonical_id = $1) AND guild_id = $2 AND status = 'open' RETURNING id`,
    [reportId, guildId, status, actorId, action === 'none' ? null : action]);
  if (!done.some((d) => d.id === reportId)) throw new ApiError(409, 'ALREADY_HANDLED', 'The report is already handled'); // lost a race with another moderator
  const reason = `Report: ${rep.reason}`;
  if (action === 'delete_message') {
    const gone = await ctx.db.query('DELETE FROM messages WHERE id = $1 AND channel_id = $2 RETURNING id, attachments', [rep.message_id, rep.channel_id]);
    if (gone.length) {
      await deleteAttachmentFiles(ctx, gone.map((r) => r.attachments)).catch((e) => ctx.log.warn({ err: e }, 'attachment cleanup failed'));
      await settleLastMessage(ctx, [rep.channel_id]);
      await ctx.hub.toChannel(rep.channel_id, 'MESSAGE_DELETE', { id: rep.message_id, channelId: rep.channel_id, guildId });
      await audit(ctx, guildId, actorId, 'MESSAGE_DELETE', rep.message_id, { channelId: rep.channel_id, authorId: rep.target_user_id, viaReport: reportId }, reason);
    }
  } else if (action === 'mark_sensitive') {
    const a = await channelAccessFor();
    await setSensitive(ctx, a.channel, rep.message_id, actorId, true, reason);
  } else if (action === 'warn') {
    await ctx.db.query(`INSERT INTO mod_warnings (id, guild_id, user_id, moderator_id, reason, source) VALUES ($1,$2,$3,$4,$5,'manual')`, [snowflake(), guildId, rep.target_user_id, actorId, `Reported for ${rep.reason}`]);
    await audit(ctx, guildId, actorId, 'MEMBER_WARN', rep.target_user_id, { viaReport: reportId }, `Reported for ${rep.reason}`);
    const [g] = await ctx.db.query('SELECT name FROM guilds WHERE id = $1', [guildId]);
    await ctx.hub.toUser(rep.target_user_id, 'MOD_WARNING', { guildId, guildName: g.name, reason: `Reported for ${rep.reason}`, createdAt: new Date().toISOString() });
  } else if (action === 'timeout') {
    const until = new Date(Date.now() + REPORT_TIMEOUT_MINUTES * 60_000);
    await ctx.db.query('UPDATE members SET timeout_until = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, rep.target_user_id, until]);
    await ctx.pcache.invalidate({ k: 'member', guildId, userId: rep.target_user_id });
    await audit(ctx, guildId, actorId, 'MEMBER_TIMEOUT', rep.target_user_id, { until: until.toISOString(), viaReport: reportId }, reason);
    const m = await memberDTO(ctx, guildId, rep.target_user_id);
    if (m) await ctx.hub.toGuild(guildId, 'MEMBER_UPDATE', m);
    await sendRemovalNotice(ctx, guildId, rep.target_user_id, 'timeout', { reason, moderatorId: actorId, until }).catch(() => null);
  }
  await audit(ctx, guildId, actorId, status === 'resolved' ? 'REPORT_RESOLVE' : 'REPORT_DISMISS', reportId, action === 'none' ? null : { action });
  await ctx.hub.toGuild(guildId, 'GUILD_REPORTS_UPDATE', { guildId });
  return (await getReport(ctx, guildId, reportId, actorId))!;
}
