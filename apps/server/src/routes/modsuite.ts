import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MOD_SETTINGS_LIMITS, Perm, diffFields, has, normalizeModSettings, type ModPrefs, type ModSettings } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { auditDTO, queryAudit } from '../services/auditQuery';
import { hintsWithUsers } from '../services/evasion';
import { audit } from '../services/guilds';
import { loadModSettings } from '../services/modSettings';
import { listNotices } from '../services/modNotices';
import { channelAccess, guildAccess, guildPerms, need } from '../services/perms';
import { setSensitive } from '../services/sensitive';
import { usersByIds } from '../services/serializers';
import { csvCell, needAnyMod } from './modtools';

const gid = z.object({ id: idSchema });
const section = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().strict();
const patchSettings = z.object({
  rememberRoles: section({ enabled: z.boolean(), onKick: z.boolean(), onLeave: z.boolean(), days: z.number().int().min(MOD_SETTINGS_LIMITS.rememberDays[0]).max(MOD_SETTINGS_LIMITS.rememberDays[1]) }),
  notices: section({ enabled: z.boolean(), showModerator: z.boolean(), appealLink: z.boolean() }),
  evasion: section({ enabled: z.boolean() }),
  retention: section({ auditDays: z.number().int().min(MOD_SETTINGS_LIMITS.auditDays[0]).max(MOD_SETTINGS_LIMITS.auditDays[1]).nullable(), editDays: z.number().int().min(MOD_SETTINGS_LIMITS.editDays[0]).max(MOD_SETTINGS_LIMITS.editDays[1]).nullable() }),
  wellbeing: section({ blurMedia: z.boolean() }),
}).partial().strict();

const auditFilters = z.object({
  limit: z.coerce.number().optional(), before: idSchema.optional(), action: z.string().max(64).optional(), actionType: z.coerce.number().int().min(0).max(1000).optional(),
  actorId: idSchema.optional(), targetId: idSchema.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), q: z.string().trim().min(1).max(100).optional(),
});

/** Package F: audit export, moderation settings, removal notices, moderator wellbeing, ban-evasion queue, sensitive-content marks. See docs/MODERATION.md. */
export function modSuiteRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---------- audit log: filtered page + CSV ----------
  app.get('/guilds/:id/audit-logs', async (req) => {
    const { id } = parse(gid, req.params);
    const q = parse(auditFilters, req.query);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.VIEW_AUDIT_LOG);
    if (q.q) limitOrThrow(ctx.rl, `audit-search:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    return (await queryAudit(ctx, id, { ...q, limit: limitParam(q.limit) })).map(auditDTO);
  });

  app.get('/guilds/:id/audit-logs.csv', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const q = parse(auditFilters.omit({ before: true }), req.query);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.VIEW_AUDIT_LOG);
    limitOrThrow(ctx.rl, `audit-export:${req.userId}`, 5, 60_000, ctx.config.rateLimit);
    const rows = await queryAudit(ctx, id, { ...q, limit: limitParam(q.limit, 10_000, 10_000) });
    const users = await usersByIds(ctx, [...new Set(rows.flatMap((r) => [r.actor_id, r.target_id].filter(Boolean)))]);
    const head = ['id', 'time', 'action', 'actor_id', 'actor_name', 'target_id', 'target_name', 'reason', 'changes', 'before', 'after'];
    const lines = [head.join(','), ...rows.map((r) => [r.id, iso(r.created_at), r.action, r.actor_id, users.get(r.actor_id)?.username, r.target_id, r.target_id ? users.get(r.target_id)?.username : '', r.reason, r.changes, r.diff?.before, r.diff?.after].map(csvCell).join(','))];
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="audit-log-${id}.csv"`).header('cache-control', 'no-store');
    return reply.send('﻿' + lines.join('\r\n') + '\r\n');
  });

  // ---------- moderation settings ----------
  app.get('/guilds/:id/mod-settings', async (req): Promise<ModSettings> => {
    const { id } = parse(gid, req.params);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, id)));
    return loadModSettings(ctx, id);
  });
  app.patch('/guilds/:id/mod-settings', async (req): Promise<ModSettings> => {
    const { id } = parse(gid, req.params);
    const b = parse(patchSettings, req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    const cur = await loadModSettings(ctx, id);
    const next = normalizeModSettings(Object.fromEntries((Object.keys(cur) as (keyof ModSettings)[]).map((k) => [k, { ...cur[k], ...(b[k] ?? {}) }])));
    await ctx.db.query('UPDATE guilds SET mod_settings = $2::jsonb WHERE id = $1', [id, JSON.stringify(next)]);
    await audit(ctx, id, req.userId, 'MOD_SETTINGS_UPDATE', id, b, null, diffFields(cur as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>));
    return next;
  });

  // ---------- removal notices (what the removed member sees) ----------
  app.get('/users/@me/mod-notices', async (req) => listNotices(ctx, req.userId));
  app.post('/users/@me/mod-notices/read', async (req, reply) => {
    await ctx.db.query('UPDATE mod_notices SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.userId]);
    return reply.code(204).send();
  });

  // ---------- a moderator's own wellbeing settings ----------
  const prefsDTO = (p: any): ModPrefs => ({ blurMedia: typeof p?.blur_media === 'boolean' ? p.blur_media : null, quietStart: p?.quiet_start ?? null, quietEnd: p?.quiet_end ?? null, tzOffset: p?.tz_offset ?? 0 });
  app.get('/guilds/:id/mod-prefs', async (req) => {
    const { id } = parse(gid, req.params);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, id)));
    const [p] = await ctx.db.query('SELECT * FROM mod_prefs WHERE guild_id = $1 AND user_id = $2', [id, req.userId]);
    return { ...prefsDTO(p), serverBlurDefault: (await loadModSettings(ctx, id)).wellbeing.blurMedia };
  });
  app.put('/guilds/:id/mod-prefs', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({
      blurMedia: z.boolean().nullable(), quietStart: z.number().int().min(0).max(1439).nullable(), quietEnd: z.number().int().min(0).max(1439).nullable(), tzOffset: z.number().int().min(-840).max(840),
    }).partial().strict(), req.body);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, id)));
    const [cur] = await ctx.db.query('SELECT * FROM mod_prefs WHERE guild_id = $1 AND user_id = $2', [id, req.userId]);
    const next = { ...prefsDTO(cur), ...b };
    if ((next.quietStart === null) !== (next.quietEnd === null)) throw badRequest('Set both ends of the quiet hours, or neither');
    await ctx.db.query(
      `INSERT INTO mod_prefs (guild_id, user_id, blur_media, quiet_start, quiet_end, tz_offset) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET blur_media = EXCLUDED.blur_media, quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, tz_offset = EXCLUDED.tz_offset`,
      [id, req.userId, next.blurMedia, next.quietStart, next.quietEnd, next.tzOffset]);
    return { ...next, serverBlurDefault: (await loadModSettings(ctx, id)).wellbeing.blurMedia };
  });

  // ---------- ban-evasion hints ----------
  app.get('/guilds/:id/evasion-hints', async (req) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ status: z.enum(['open', 'dismissed', 'confirmed', 'all']).default('open'), limit: z.coerce.number().optional() }), req.query);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, id)));
    const rows = await ctx.db.query(`SELECT * FROM evasion_hints WHERE guild_id = $1 AND ($2 OR status = $3) ORDER BY id DESC LIMIT $4`, [id, q.status === 'all', q.status, limitParam(q.limit, 50, 100)]);
    return hintsWithUsers(ctx, rows);
  });
  app.patch('/guilds/:id/evasion-hints/:hid', async (req) => {
    const p = parse(z.object({ id: idSchema, hid: idSchema }), req.params);
    const b = parse(z.object({ status: z.enum(['dismissed', 'confirmed']) }).strict(), req.body);
    needAnyMod(guildPerms(await guildAccess(ctx, req.userId, p.id)));
    const rows = await ctx.db.query(`UPDATE evasion_hints SET status = $3, handled_by = $4, handled_at = now() WHERE id = $1 AND guild_id = $2 AND status = 'open' RETURNING *`, [p.hid, p.id, b.status, req.userId]);
    if (!rows.length) {
      const [ex] = await ctx.db.query('SELECT 1 AS x FROM evasion_hints WHERE id = $1 AND guild_id = $2', [p.hid, p.id]);
      if (!ex) throw notFound('Hint');
      throw new ApiError(409, 'ALREADY_HANDLED', 'This hint was already handled');
    }
    await audit(ctx, p.id, req.userId, 'EVASION_HINT_HANDLED', rows[0].user_id, { status: b.status, bannedUserId: rows[0].banned_user_id });
    await ctx.hub.toGuild(p.id, 'GUILD_REPORTS_UPDATE', { guildId: p.id });
    return (await hintsWithUsers(ctx, rows))[0];
  });

  // ---------- sensitive content (blur with click-through, content kept) ----------
  const mm = z.object({ id: idSchema, mid: idSchema });
  app.put('/channels/:id/messages/:mid/sensitive', async (req, reply) => {
    const p = parse(mm, req.params);
    const b = parse(z.object({ reason: z.string().trim().max(200).optional() }).strict().default({}), req.body ?? {});
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!a.channel.guild_id) throw badRequest('Only server messages can be marked sensitive');
    limitOrThrow(ctx.rl, `sensitive:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const [m] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.author_id !== req.userId) need(a.perms, Perm.MANAGE_MESSAGES); // authors may flag their own post, moderators anyone's
    await setSensitive(ctx, a.channel, p.mid, req.userId, true, b.reason ?? null);
    return reply.code(204).send();
  });
  app.delete('/channels/:id/messages/:mid/sensitive', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!a.channel.guild_id) throw badRequest('Only server messages can be marked sensitive');
    limitOrThrow(ctx.rl, `sensitive:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    if (!has(a.perms, Perm.MANAGE_MESSAGES)) throw forbidden('Only moderators can clear a sensitive mark');
    await setSensitive(ctx, a.channel, p.mid, req.userId, false);
    return reply.code(204).send();
  });
}
