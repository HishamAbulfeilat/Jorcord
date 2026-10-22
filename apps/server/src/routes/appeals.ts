import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { ApiError, forbidden, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { Perm } from '@jorcord/shared';
import { audit } from '../services/guilds';
import { guildAccess, guildPerms, need } from '../services/perms';
import { usersByIds } from '../services/serializers';
import { APPEAL_MAX, APPEAL_MIN, newAppealId, notifyAppealCreated, notifyAppealDecided, ownAppealDTO } from '../services/appeals';

export function appealRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- appellant (account based: the banned user is still a normal signed-in user) ----
  /** Servers I am banned from, with the state of my (single) appeal for each. Only the caller's own rows. */
  app.get('/users/@me/bans', async (req) => {
    const rows = await ctx.db.query(
      `SELECT b.guild_id, b.reason, b.created_at, g.name, g.icon,
              a.id AS a_id, a.status, a.message, a.created_at AS a_created, a.decided_at, a.decision_reason
         FROM bans b JOIN guilds g ON g.id = b.guild_id
         LEFT JOIN ban_appeals a ON a.guild_id = b.guild_id AND a.user_id = b.user_id AND a.ban_created_at = b.created_at
        WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [req.userId]);
    return rows.map((r) => ({
      guild: { id: r.guild_id as string, name: r.name as string, icon: (r.icon ?? null) as string | null }, reason: (r.reason ?? null) as string | null, bannedAt: iso(r.created_at)!,
      appeal: r.a_id ? ownAppealDTO({ id: r.a_id, guild_id: r.guild_id, user_id: req.userId, ban_created_at: r.created_at, message: r.message, status: r.status, decided_by: null, decision_reason: r.decision_reason, decided_at: r.decided_at, created_at: r.a_created }) : null,
    }));
  });

  app.post('/users/@me/bans/:guildId/appeal', async (req, reply) => {
    const { guildId } = parse(z.object({ guildId: idSchema }), req.params);
    const { message } = parse(z.object({ message: z.string().trim().min(APPEAL_MIN).max(APPEAL_MAX) }).strict(), req.body);
    limitOrThrow(ctx.rl, `appeal:${req.userId}`, 5, 24 * 3600_000, ctx.config.rateLimit);   // per appellant
    limitOrThrow(ctx.rl, `appeal-guild:${guildId}`, 50, 24 * 3600_000, ctx.config.rateLimit); // a ban evader network cannot flood one queue
    const [ban] = await ctx.db.query('SELECT created_at FROM bans WHERE guild_id = $1 AND user_id = $2', [guildId, req.userId]); // scoped to the caller: no way to probe other people's bans
    if (!ban) throw notFound('Ban');
    const rows = await ctx.db.query(
      'INSERT INTO ban_appeals (id, guild_id, user_id, ban_created_at, message) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (guild_id, user_id, ban_created_at) DO NOTHING RETURNING *',
      [newAppealId(), guildId, req.userId, ban.created_at, message]);
    if (!rows.length) throw new ApiError(409, 'APPEAL_EXISTS', 'You already appealed this ban');
    const a = rows[0];
    await audit(ctx, guildId, req.userId, 'BAN_APPEAL_CREATE', req.userId); // no appeal text in the audit log
    void notifyAppealCreated(ctx, a.id, guildId).catch((e) => ctx.log.warn({ err: e }, 'appeal notify failed'));
    return reply.code(201).send(ownAppealDTO(a));
  });

  // ---- moderators (BAN_MEMBERS) ----
  app.get('/guilds/:id/appeals', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'denied', 'all']).default('pending') }), req.query);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.BAN_MEMBERS);
    // a pending appeal is only actionable while the ban it belongs to still exists
    const rows = await ctx.db.query(
      `SELECT a.*, b.reason AS ban_reason, (b.user_id IS NOT NULL) AS still_banned FROM ban_appeals a
         LEFT JOIN bans b ON b.guild_id = a.guild_id AND b.user_id = a.user_id AND b.created_at = a.ban_created_at
        WHERE a.guild_id = $1 AND ($2 = 'all' OR a.status = $2) AND (a.status <> 'pending' OR b.user_id IS NOT NULL)
        ORDER BY a.created_at DESC LIMIT 200`, [id, q.status]);
    const users = await usersByIds(ctx, [...new Set(rows.flatMap((r) => [r.user_id as string, r.decided_by as string].filter(Boolean)))]);
    return rows.map((r) => ({
      id: r.id as string, guildId: id, user: users.get(r.user_id) ?? null, message: r.message as string, status: r.status as string, banReason: (r.ban_reason ?? null) as string | null,
      bannedAt: iso(r.ban_created_at)!, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at), decidedBy: r.decided_by ? users.get(r.decided_by) ?? null : null, decisionReason: (r.decision_reason ?? null) as string | null,
    }));
  });

  app.post('/guilds/:id/appeals/:appealId', async (req) => {
    const p = parse(z.object({ id: idSchema, appealId: idSchema }), req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'deny']), reason: z.string().trim().max(512).nullable().optional() }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.BAN_MEMBERS);
    limitOrThrow(ctx.rl, `appeal-decide:${req.userId}`, 60, 15 * 60_000, ctx.config.rateLimit);
    const [cur] = await ctx.db.query('SELECT * FROM ban_appeals WHERE id = $1 AND guild_id = $2', [p.appealId, p.id]); // guild_id in the lookup = IDOR guard across servers
    if (!cur) throw notFound('Appeal');
    if (cur.user_id === req.userId) throw forbidden('You cannot decide your own appeal', 'FORBIDDEN');
    const status = b.decision === 'approve' ? 'approved' : 'denied';
    // single winner when two moderators click at once
    const [a] = await ctx.db.query(
      `UPDATE ban_appeals SET status = $3, decided_by = $4, decision_reason = $5, decided_at = now() WHERE id = $1 AND guild_id = $2 AND status = 'pending' RETURNING *`,
      [p.appealId, p.id, status, req.userId, b.reason || null]);
    if (!a) throw new ApiError(409, 'APPEAL_DECIDED', 'This appeal was already decided');
    if (status === 'approved') {
      const unbanned = await ctx.db.query('DELETE FROM bans WHERE guild_id = $1 AND user_id = $2 AND created_at = $3 RETURNING user_id', [p.id, a.user_id, a.ban_created_at]);
      if (unbanned.length) await audit(ctx, p.id, req.userId, 'MEMBER_BAN_REMOVE', a.user_id, null, b.reason || 'Ban appeal approved');
    }
    await audit(ctx, p.id, req.userId, status === 'approved' ? 'BAN_APPEAL_APPROVE' : 'BAN_APPEAL_DENY', a.user_id, null, b.reason || null);
    const [g] = await ctx.db.query('SELECT name FROM guilds WHERE id = $1', [p.id]);
    void notifyAppealDecided(ctx, a, g?.name ?? 'the server').catch((e) => ctx.log.warn({ err: e }, 'appeal notify failed'));
    return { id: a.id as string, status, decidedAt: iso(a.decided_at)!, decisionReason: (a.decision_reason ?? null) as string | null };
  });
}
