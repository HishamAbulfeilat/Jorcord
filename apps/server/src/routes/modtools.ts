import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MOD_LIMITS, Perm, has, snowflake, REPORT_REASONS, type Attachment, type BulkModerationResult, type ModHistoryEntry, type ModNote, type ModView, type ModWarning, type PruneResult, type ReportReason, type Report, type SafetyFlag } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, loadGuildPerms, need, needOutrankMember, type GuildPerm } from '../services/perms';
import { normalizePrivacy } from '../services/privacy';
import { usersByIds, userDTO } from '../services/serializers';
import { removeMemberFromGuild } from './members';

const DAY = 86_400_000;
export const warningDTO = (r: any): ModWarning => ({ id: r.id, guildId: r.guild_id, userId: r.user_id, moderatorId: r.moderator_id ?? null, reason: r.reason, source: r.source, ruleId: r.rule_id ?? null, createdAt: iso(r.created_at)! });
export const noteDTO = (r: any): ModNote => ({ id: r.id, guildId: r.guild_id, userId: r.user_id, authorId: r.author_id ?? null, note: r.note, createdAt: iso(r.created_at)! });
const MOD_VIEW_PERMS = Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_GUILD;
const needAnyMod = (perms: bigint) => { if (!(perms & MOD_VIEW_PERMS)) throw forbidden('Missing moderation permissions', 'MISSING_PERMISSIONS'); };

/** Escapes a CSV cell; cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const MOD_ACTIONS = ['MEMBER_KICK', 'MEMBER_PRUNE', 'MEMBER_BAN_ADD', 'MEMBER_BAN_REMOVE', 'MEMBER_UPDATE', 'MEMBER_ROLE_UPDATE', 'MEMBER_TIMEOUT', 'MEMBER_WARN', 'MEMBER_WARN_DELETE', 'MEMBER_BULK_BAN', 'MEMBER_BULK_KICK', 'MOD_NOTE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_BULK_DELETE', 'AUTOMOD_BLOCK', 'AUTOMOD_ALERT', 'AUTOMOD_TEST', 'RAID_DETECTED', 'VOICE_MODERATE', 'VOICE_DISCONNECT', 'VOICE_MOVE'];

/** Safety flags for one member (see SAFETY_FLAGS). */
export async function safetyFlags(ctx: Ctx, guildId: string, userId: string): Promise<SafetyFlag[]> {
  const flags: SafetyFlag[] = [];
  const [u] = await ctx.db.query('SELECT created_at, privacy FROM users WHERE id = $1', [userId]); if (!u) return flags;
  if (Date.now() - new Date(u.created_at).getTime() < 7 * DAY) flags.push('new_account');
  const [m] = await ctx.db.query('SELECT raid_flagged, impersonation_flag FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (m?.raid_flagged) flags.push('raid_joined');
  if (m?.impersonation_flag) flags.push('impersonation');
  const [a] = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE guild_id = $1 AND actor_id = $2 AND action IN ('AUTOMOD_BLOCK','AUTOMOD_ALERT') AND created_at > now() - interval '24 hours'`, [guildId, userId]);
  if (a.n >= 3) flags.push('spam_suspect');
  if (!normalizePrivacy(u.privacy).allowDmsFromServerMembers) flags.push('dm_restricted');
  return flags;
}

/** Members matching a bulk filter (never "everyone": at least one criterion is required by the caller). */
async function filterMembers(ctx: Ctx, guildId: string, f: { joinedWithinMinutes?: number; noRoles?: boolean; accountYoungerThanDays?: number; raidFlagged?: boolean }, limit: number): Promise<string[]> {
  const rows = await ctx.db.query(
    `SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND NOT u.bot
       AND ($2::int IS NULL OR m.joined_at > now() - ($2::int * interval '1 minute'))
       AND (NOT $3::boolean OR NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id))
       AND ($4::int IS NULL OR u.created_at > now() - ($4::int * interval '1 day'))
       AND (NOT $5::boolean OR m.raid_flagged)
     ORDER BY m.joined_at DESC, m.user_id LIMIT $6`, [guildId, f.joinedWithinMinutes ?? null, !!f.noRoles, f.accountYoungerThanDays ?? null, !!f.raidFlagged, limit]);
  return rows.map((r) => r.user_id as string);
}

export function modToolRoutes(app: FastifyInstance, ctx: Ctx) {
  const gid = z.object({ id: idSchema }); const gu = z.object({ id: idSchema, userId: idSchema });

  // ---------- mod view ----------
  app.get('/guilds/:id/members/:userId/mod-view', async (req): Promise<ModView> => {
    const p = parse(gu, req.params);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, p.id)));
    limitOrThrow(ctx.rl, `mod-view:${req.userId}`, 120, 60_000, ctx.config.rateLimit);
    const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [p.userId]); if (!u) throw notFound('User');
    const [m] = await ctx.db.query('SELECT * FROM members WHERE guild_id = $1 AND user_id = $2', [p.id, p.userId]);
    const [ban] = await ctx.db.query('SELECT 1 AS x FROM bans WHERE guild_id = $1 AND user_id = $2', [p.id, p.userId]);
    if (!m && !ban && !(await ctx.db.query('SELECT 1 FROM audit_log WHERE guild_id = $1 AND target_id = $2 LIMIT 1', [p.id, p.userId])).length) throw notFound('Member'); // not an existence oracle for strangers
    const roles = m ? (await ctx.db.query('SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2', [p.id, p.userId])).map((r) => r.role_id as string) : [];
    const hist = await ctx.db.query(`SELECT action, actor_id, reason, created_at FROM audit_log WHERE guild_id = $1 AND target_id = $2 AND action IN ('MEMBER_TIMEOUT','MEMBER_BAN_ADD','MEMBER_BAN_REMOVE','MEMBER_KICK','MEMBER_WARN') ORDER BY id DESC LIMIT 50`, [p.id, p.userId]);
    const [cnt] = await ctx.db.query(`SELECT count(*) FILTER (WHERE action = 'MEMBER_TIMEOUT' AND (changes IS NULL OR changes->>'until' IS NOT NULL))::int AS timeouts, count(*) FILTER (WHERE action = 'MEMBER_BAN_ADD')::int AS bans, count(*) FILTER (WHERE action = 'MEMBER_KICK')::int AS kicks FROM audit_log WHERE guild_id = $1 AND target_id = $2`, [p.id, p.userId]);
    const warns = await ctx.db.query('SELECT * FROM mod_warnings WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 50', [p.id, p.userId]);
    const [wn] = await ctx.db.query('SELECT count(*)::int AS n FROM mod_warnings WHERE guild_id = $1 AND user_id = $2', [p.id, p.userId]);
    const [am] = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE guild_id = $1 AND actor_id = $2 AND action IN ('AUTOMOD_BLOCK','AUTOMOD_ALERT') AND created_at > now() - interval '24 hours'`, [p.id, p.userId]);
    const notes = await ctx.db.query('SELECT * FROM mod_notes WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 50', [p.id, p.userId]);
    const mutual = await ctx.db.query('SELECT g.id, g.name FROM guilds g JOIN members a ON a.guild_id = g.id AND a.user_id = $1 JOIN members b ON b.guild_id = g.id AND b.user_id = $2 ORDER BY g.name LIMIT 50', [req.userId, p.userId]);
    const [msg] = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE guild_id = $1 AND author_id = $2 AND id > $3', [p.id, p.userId, snowflake(Date.now() - 7 * DAY)]);
    return {
      user: userDTO(ctx, u), isMember: !!m, joinedAt: iso(m?.joined_at), accountCreatedAt: iso(u.created_at)!, roles, timeoutUntil: m?.timeout_until && new Date(m.timeout_until).getTime() > Date.now() ? iso(m.timeout_until) : null, banned: !!ban,
      flags: await safetyFlags(ctx, p.id, p.userId), counts: { timeouts: cnt.timeouts, bans: cnt.bans, kicks: cnt.kicks, warnings: wn.n, automodHits24h: am.n },
      history: hist.map((r): ModHistoryEntry => ({ action: r.action, moderatorId: r.actor_id, reason: r.reason ?? null, createdAt: iso(r.created_at)! })), warnings: warns.map(warningDTO), notes: notes.map(noteDTO),
      mutualGuilds: mutual.map((g) => ({ id: g.id, name: g.name })), messages7d: msg.n,
    };
  });

  // ---------- warnings ----------
  app.get('/guilds/:id/members/:userId/warnings', async (req) => {
    const p = parse(gu, req.params); needAnyMod(guildPerms(await guildAccess(ctx, req.userId, p.id)));
    return (await ctx.db.query('SELECT * FROM mod_warnings WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 100', [p.id, p.userId])).map(warningDTO);
  });
  app.post('/guilds/:id/members/:userId/warnings', async (req, reply) => {
    const p = parse(gu, req.params); const b = parse(z.object({ reason: z.string().trim().min(1).max(MOD_LIMITS.warningLength) }).strict(), req.body);
    const actor = await guildAccess(ctx, req.userId, p.id); need(guildPerms(actor), Perm.MODERATE_MEMBERS);
    limitOrThrow(ctx.rl, `warn:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    if (p.userId === req.userId) throw badRequest('Cannot warn yourself');
    const target = await loadGuildPerm(ctx, p.id, p.userId); if (!target) throw notFound('Member');
    needOutrankMember(actor, target);
    const [t] = await ctx.db.query('SELECT bot FROM users WHERE id = $1', [p.userId]); if (t?.bot) throw badRequest('Bots cannot be warned');
    const id = snowflake();
    await ctx.db.query(`INSERT INTO mod_warnings (id, guild_id, user_id, moderator_id, reason, source) VALUES ($1,$2,$3,$4,$5,'manual')`, [id, p.id, p.userId, req.userId, b.reason]);
    const [row] = await ctx.db.query('SELECT * FROM mod_warnings WHERE id = $1', [id]);
    await audit(ctx, p.id, req.userId, 'MEMBER_WARN', p.userId, null, b.reason);
    const [g] = await ctx.db.query('SELECT name FROM guilds WHERE id = $1', [p.id]);
    await ctx.hub.toUser(p.userId, 'MOD_WARNING', { guildId: p.id, guildName: g.name, reason: b.reason, createdAt: iso(row.created_at)! }); // only the warned member hears about it
    return reply.code(201).send(warningDTO(row));
  });
  app.delete('/guilds/:id/warnings/:wid', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, wid: idSchema }), req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MODERATE_MEMBERS);
    const rows = await ctx.db.query('DELETE FROM mod_warnings WHERE id = $1 AND guild_id = $2 RETURNING user_id', [p.wid, p.id]);
    if (!rows.length) throw notFound('Warning');
    await audit(ctx, p.id, req.userId, 'MEMBER_WARN_DELETE', rows[0].user_id);
    return reply.code(204).send();
  });

  // ---------- notes ----------
  app.post('/guilds/:id/members/:userId/notes', async (req, reply) => {
    const p = parse(gu, req.params); const b = parse(z.object({ note: z.string().trim().min(1).max(MOD_LIMITS.noteLength) }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MODERATE_MEMBERS);
    limitOrThrow(ctx.rl, `mod-note:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const [u] = await ctx.db.query('SELECT 1 AS x FROM users WHERE id = $1', [p.userId]); if (!u) throw notFound('User');
    const [n] = await ctx.db.query('SELECT count(*)::int AS c FROM mod_notes WHERE guild_id = $1 AND user_id = $2', [p.id, p.userId]);
    if (n.c >= MOD_LIMITS.notesPerMember) throw new ApiError(400, 'LIMIT_REACHED', `At most ${MOD_LIMITS.notesPerMember} notes per member`);
    const id = snowflake();
    await ctx.db.query('INSERT INTO mod_notes (id, guild_id, user_id, author_id, note) VALUES ($1,$2,$3,$4,$5)', [id, p.id, p.userId, req.userId, b.note]);
    await audit(ctx, p.id, req.userId, 'MOD_NOTE_UPDATE', p.userId, { added: true });
    return reply.code(201).send(noteDTO((await ctx.db.query('SELECT * FROM mod_notes WHERE id = $1', [id]))[0]));
  });
  /** The author, or someone with MANAGE_GUILD, may remove a note. */
  app.delete('/guilds/:id/notes/:nid', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, nid: idSchema }), req.params);
    const perms = guildPerms(await guildAccess(ctx, req.userId, p.id)); need(perms, Perm.MODERATE_MEMBERS);
    const [n] = await ctx.db.query('SELECT * FROM mod_notes WHERE id = $1 AND guild_id = $2', [p.nid, p.id]); if (!n) throw notFound('Note');
    if (n.author_id !== req.userId && !has(perms, Perm.MANAGE_GUILD)) throw forbidden('Only the author or a server manager can remove a note');
    await ctx.db.query('DELETE FROM mod_notes WHERE id = $1', [p.nid]);
    await audit(ctx, p.id, req.userId, 'MOD_NOTE_UPDATE', n.user_id, { removed: true });
    return reply.code(204).send();
  });

  // ---------- bulk ban / kick ----------
  const filterSchema = z.object({ joinedWithinMinutes: z.number().int().min(1).max(MOD_LIMITS.filterMinutesMax), noRoles: z.boolean(), accountYoungerThanDays: z.number().int().min(1).max(365), raidFlagged: z.boolean() }).partial().strict();
  app.post('/guilds/:id/moderation/bulk', async (req): Promise<BulkModerationResult> => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ action: z.enum(['ban', 'kick']), userIds: z.array(idSchema).max(MOD_LIMITS.bulkIds).optional(), filter: filterSchema.optional(), reason: z.string().trim().max(512).nullable().optional(), dryRun: z.boolean().default(true) }).strict(), req.body);
    const actor = await guildAccess(ctx, req.userId, id); need(guildPerms(actor), b.action === 'ban' ? Perm.BAN_MEMBERS : Perm.KICK_MEMBERS);
    const hasFilter = !!b.filter && Object.values(b.filter).some((v) => v !== undefined && v !== false);
    if (!b.userIds?.length && !hasFilter) throw badRequest('Give a list of user ids or at least one filter');
    limitOrThrow(ctx.rl, `bulk-mod:${id}`, b.dryRun ? 20 : 3, 60_000, ctx.config.rateLimit);
    const ids = new Set<string>(b.userIds ?? []);
    if (hasFilter) for (const u of await filterMembers(ctx, id, b.filter!, MOD_LIMITS.bulkMax)) ids.add(u);
    const list = [...ids].slice(0, MOD_LIMITS.bulkMax);
    const targets = await loadGuildPerms(ctx, id, list);
    const existing = new Set((await ctx.db.query('SELECT id FROM users WHERE id = ANY($1::text[])', [list])).map((r) => r.id as string));
    const skipped: BulkModerationResult['skipped'] = []; const ok: string[] = [];
    for (const uid of list) {
      const t: GuildPerm | undefined = targets.get(uid);
      if (uid === req.userId) { skipped.push({ userId: uid, reason: 'That is you' }); continue; }
      if (!existing.has(uid)) { skipped.push({ userId: uid, reason: 'Unknown user' }); continue; }
      if (!t && b.action === 'kick') { skipped.push({ userId: uid, reason: 'Not a member' }); continue; }
      if (t) { try { needOutrankMember(actor, t); } catch { skipped.push({ userId: uid, reason: t.isOwner ? 'Server owner' : 'Outranks you' }); continue; } }
      else { const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [id]); if (g.owner_id === uid) { skipped.push({ userId: uid, reason: 'Server owner' }); continue; } }
      if (b.action === 'ban' && (await ctx.db.query('SELECT 1 FROM bans WHERE guild_id = $1 AND user_id = $2', [id, uid])).length) { skipped.push({ userId: uid, reason: 'Already banned' }); continue; }
      ok.push(uid);
    }
    const names = await usersByIds(ctx, ok.slice(0, 50));
    const result: BulkModerationResult = { dryRun: b.dryRun, action: b.action, matched: list.length, affected: b.dryRun ? ok.length : 0, skipped, users: [...names.values()].map((u) => ({ id: u.id, username: u.username })) };
    if (b.dryRun || !ok.length) return result;
    let done = 0;
    for (const uid of ok) {
      if (b.action === 'ban') {
        await ctx.db.query('INSERT INTO bans (guild_id, user_id, reason, banned_by) VALUES ($1,$2,$3,$4) ON CONFLICT (guild_id, user_id) DO NOTHING', [id, uid, b.reason ?? null, req.userId]);
        await ctx.pcache.invalidate({ k: 'member', guildId: id, userId: uid });
      }
      if (targets.has(uid)) await removeMemberFromGuild(ctx, id, uid);
      done++;
    }
    await audit(ctx, id, req.userId, b.action === 'ban' ? 'MEMBER_BULK_BAN' : 'MEMBER_BULK_KICK', null, { count: done, userIds: ok.slice(0, 200), filter: b.filter ?? null }, b.reason ?? null);
    return { ...result, affected: done };
  });

  // ---------- prune ----------
  /** Members who joined more than `days` ago, have not posted in `days`, hold no role (unless `includeRoles` names roles to include), are not bots and may be kicked by the caller. */
  async function pruneCandidates(guildId: string, days: number, includeRoles: string[]): Promise<string[]> {
    const cutoff = snowflake(Date.now() - days * DAY);
    const rows = await ctx.db.query(
      `SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.guild_id = $1 AND NOT u.bot AND m.joined_at < now() - ($2::int * interval '1 day')
           AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.guild_id = m.guild_id AND x.author_id = m.user_id AND x.type IN ('default','reply') AND x.id > $3)
           AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id AND NOT (r.role_id = ANY($4::text[])))
         ORDER BY m.joined_at LIMIT 5000`, [guildId, days, cutoff, includeRoles]);
    return rows.map((r) => r.user_id as string);
  }
  app.post('/guilds/:id/prune', async (req): Promise<PruneResult> => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ days: z.number().int().min(1).max(MOD_LIMITS.pruneMaxDays), includeRoles: z.array(idSchema).max(20).default([]), dryRun: z.boolean().default(true) }).strict(), req.body);
    const actor = await guildAccess(ctx, req.userId, id); need(guildPerms(actor), Perm.KICK_MEMBERS);
    limitOrThrow(ctx.rl, `prune:${id}`, b.dryRun ? 20 : 2, 60_000, ctx.config.rateLimit);
    if (b.includeRoles.length) { const ok = await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [id, b.includeRoles]); if (ok.length !== new Set(b.includeRoles).size) throw badRequest('Unknown role'); }
    const all = await pruneCandidates(id, b.days, b.includeRoles);
    const perms = await loadGuildPerms(ctx, id, all);
    const eligible = all.filter((u) => { const t = perms.get(u); if (!t || u === req.userId) return false; try { needOutrankMember(actor, t); return true; } catch { return false; } });
    if (b.dryRun) return { dryRun: true, days: b.days, count: eligible.length, removed: 0, remaining: eligible.length };
    const batch = eligible.slice(0, MOD_LIMITS.pruneBatch);
    for (const u of batch) await removeMemberFromGuild(ctx, id, u);
    await audit(ctx, id, req.userId, 'MEMBER_PRUNE', null, { days: b.days, removed: batch.length, includeRoles: b.includeRoles });
    return { dryRun: false, days: b.days, count: eligible.length, removed: batch.length, remaining: eligible.length - batch.length };
  });

  // ---------- reports (mod queue): users report member messages, moderators triage see CONTRACT.md ----------
  const reasonEnum = z.enum(REPORT_REASONS);
  const reportDTO = (r: any, message: { content: string; attachments: unknown } | null): Report => ({
    id: r.id, guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id, reporterId: r.reporter_id, targetUserId: r.target_user_id,
    reason: r.reason as ReportReason, description: r.description ?? null,
    message: message ? { content: message.content, attachments: (message.attachments ?? []) as Attachment[] } : null,
    status: r.status, handledBy: r.handled_by ?? null, handledAt: r.handled_at ? iso(r.handled_at) : null, createdAt: iso(r.created_at)!,
  });
  const joinedReport = async (guildId: string, reportId: string) =>
    (await ctx.db.query(`SELECT r.*, m.content AS msg_content, m.attachments AS msg_attachments FROM reports r LEFT JOIN messages m ON m.id = r.message_id
      WHERE r.guild_id = $1 AND r.id = $2`, [guildId, reportId]))[0];

  app.post('/channels/:id/messages/:mid/report', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, mid: idSchema }), req.params);
    const b = parse(z.object({ reason: reasonEnum, description: z.string().max(1000).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `report:${req.userId}`, 10, 3_600_000, ctx.config.rateLimit); // 10 reports/h/user
    const a = await channelAccess(ctx, req.userId, p.id); // the sender must be able to see what they report
    if (!a.channel.guild_id) throw badRequest('Reports are for server messages'); // DMs have no moderator queue
    const [msg] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!msg) throw notFound('Message');
    if (msg.author_id === req.userId) throw badRequest('You cannot report your own message');
    const dup = await ctx.db.query(`SELECT 1 AS x FROM reports WHERE message_id = $1 AND reporter_id = $2 AND status = 'open'`, [p.mid, req.userId]);
    if (dup.length) throw new ApiError(409, 'ALREADY_REPORTED', 'You already reported this message');
    const rid = snowflake();
    await ctx.db.query('INSERT INTO reports (id, guild_id, channel_id, message_id, reporter_id, target_user_id, reason, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [rid, a.channel.guild_id, p.id, p.mid, req.userId, msg.author_id, b.reason, b.description ?? null]);
    await audit(ctx, a.channel.guild_id, req.userId, 'REPORT_CREATE', p.mid, { reason: b.reason, channelId: p.id, targetUserId: msg.author_id });
    await ctx.hub.toGuild(a.channel.guild_id, 'GUILD_REPORTS_UPDATE', { guildId: a.channel.guild_id });
    return reply.code(201).send({ id: rid });
  });

  app.get('/guilds/:id/reports', async (req) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open'), limit: z.coerce.number().optional(), before: idSchema.optional() }), req.query);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, id))); // same gate as Mod View
    const rows = await ctx.db.query(`SELECT r.*, m.content AS msg_content, m.attachments AS msg_attachments FROM reports r LEFT JOIN messages m ON m.id = r.message_id
      WHERE r.guild_id = $1 AND ($2 OR r.status = $3) AND ($4::text IS NULL OR r.id < $4::text) ORDER BY r.id DESC LIMIT $5`,
      [id, q.status === 'all', q.status, q.before ?? null, limitParam(q.limit, 50, 100)]);
    return rows.map((r) => reportDTO(r, r.msg_content === null && r.msg_attachments === null ? null : { content: r.msg_content ?? '', attachments: r.msg_attachments }));
  });

  app.patch('/guilds/:id/reports/:rid', async (req) => {
    const p = parse(z.object({ id: idSchema, rid: idSchema }), req.params);
    const b = parse(z.object({ status: z.enum(['resolved', 'dismissed']) }).strict(), req.body);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, p.id)));
    const [was] = await ctx.db.query('SELECT status FROM reports WHERE id = $1 AND guild_id = $2', [p.rid, p.id]);
    if (!was) throw notFound('Report');
    if (was.status !== 'open') throw new ApiError(409, 'ALREADY_HANDLED', 'The report is already handled');
    await ctx.db.query(`UPDATE reports SET status = $2, handled_by = $3, handled_at = now() WHERE id = $1`, [p.rid, b.status, req.userId]);
    await audit(ctx, p.id, req.userId, b.status === 'resolved' ? 'REPORT_RESOLVE' : 'REPORT_DISMISS', p.rid);
    await ctx.hub.toGuild(p.id, 'GUILD_REPORTS_UPDATE', { guildId: p.id });
    const [r] = await Promise.all([joinedReport(p.id, p.rid)]);
    return reportDTO(r, r.msg_content === null && r.msg_attachments === null ? null : { content: r.msg_content ?? '', attachments: r.msg_attachments });
  });

  // ---------- moderation log export ----------
  app.get('/guilds/:id/mod-log.csv', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), all: z.enum(['true', 'false']).optional(), limit: z.coerce.number().optional() }), req.query);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.VIEW_AUDIT_LOG);
    limitOrThrow(ctx.rl, `modlog-export:${req.userId}`, 5, 60_000, ctx.config.rateLimit);
    const rows = await ctx.db.query(
      `SELECT * FROM audit_log WHERE guild_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at <= $3) AND ($4::boolean OR action = ANY($5::text[])) ORDER BY id DESC LIMIT $6`,
      [id, q.from ?? null, q.to ?? null, q.all === 'true', MOD_ACTIONS, limitParam(q.limit, 10_000, 10_000)]);
    const users = await usersByIds(ctx, rows.flatMap((r) => [r.actor_id, r.target_id].filter(Boolean)));
    const head = ['id', 'time', 'action', 'actor_id', 'actor_name', 'target_id', 'target_name', 'reason', 'details'];
    const lines = [head.join(','), ...rows.map((r) => [r.id, iso(r.created_at), r.action, r.actor_id, users.get(r.actor_id)?.username, r.target_id, r.target_id ? users.get(r.target_id)?.username : '', r.reason, r.changes].map(csvCell).join(','))];
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="mod-log-${id}.csv"`).header('cache-control', 'no-store');
    return reply.send('﻿' + lines.join('\r\n') + '\r\n');
  });
}
