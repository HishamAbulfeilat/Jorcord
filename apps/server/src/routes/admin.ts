import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ALL_USER_FLAGS, snowflakeTime } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, notFound, unauthorized } from '../errors';
import { verifyPassword } from '../lib/crypto';
import { verifyTotp } from '../lib/totp';
import { adminAudit, godModeUntil, setGodMode, GOD_MODE_MS } from '../services/godmode';
import { buildGuildFull } from '../services/guilds';
import { memberDTO, userDTO } from '../services/serializers';
import { idSchema, parse } from '../lib/ids';

/**
 * Instance super admin: one account, named by SUPER_ADMIN_USER_ID in the server environment. It is not a role or a DB flag,
 * so nothing inside the app (guild owners, roles, other admins, the API) can grant, remove or override it.
 * Every route answers 404 to anyone else so the panel's existence is not advertised. All actions are logged.
 */
export const isSuperAdmin = (ctx: Ctx, req: FastifyRequest) => !!ctx.config.superAdminId && !req.isBot && req.userId === ctx.config.superAdminId;

const page = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) });
const like = (q?: string) => (q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const gate = (req: FastifyRequest) => {
    if (!isSuperAdmin(ctx, req)) throw notFound();
    req.log.warn({ admin: req.userId, action: `${req.method} ${req.url.split('?')[0]}` }, 'super admin action');
  };
  const id = z.object({ id: idSchema });

  app.get('/admin/me', async (req) => {
    if (!isSuperAdmin(ctx, req)) throw notFound();
    const [u] = await ctx.db.query('SELECT mfa_enabled FROM users WHERE id = $1', [req.userId]);
    const g = godModeUntil(ctx, req.userId);
    return { admin: true, userId: req.userId, mfaEnabled: !!u?.mfa_enabled, godModeUntil: g ? new Date(g).toISOString() : null };
  });

  app.get('/admin/stats', async (req) => {
    gate(req);
    const [r] = await ctx.db.query(`SELECT
      (SELECT count(*) FROM users WHERE NOT bot AND deleted_at IS NULL)::int AS users,
      (SELECT count(*) FROM users WHERE bot)::int AS bots,
      (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL)::int AS disabled,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '1 day')::int AS "newUsers24h",
      (SELECT count(*) FROM guilds)::int AS guilds,
      (SELECT count(*) FROM channels)::int AS channels,
      (SELECT count(*) FROM messages)::int AS messages,
      (SELECT count(*) FROM sessions WHERE NOT revoked AND expires_at > now())::int AS "activeSessions",
      (SELECT count(*) FROM reports)::int AS reports`);
    return r;
  });

  app.get('/admin/users', async (req) => {
    gate(req);
    const { q, limit, offset } = parse(page, req.query);
    return ctx.db.query(`SELECT u.id, u.username, u.display_name AS "displayName", u.email, u.bot, u.verified, u.mfa_enabled AS "mfaEnabled",
        u.created_at AS "createdAt", u.deleted_at AS "deletedAt", u.disabled_at AS "disabledAt",
        (SELECT count(*) FROM members m WHERE m.user_id = u.id)::int AS guilds,
        (SELECT max(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS "lastSeen"
      FROM users u WHERE ($1::text IS NULL OR u.username ILIKE $1 OR u.email ILIKE $1 OR u.id = $4)
      ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`, [like(q), limit, offset, q ?? null]);
  });

  app.get('/admin/users/:id', async (req) => {
    gate(req);
    const { id: uid } = parse(id, req.params);
    const [u] = await ctx.db.query(`SELECT id, username, display_name AS "displayName", email, bot, verified, mfa_enabled AS "mfaEnabled",
      created_at AS "createdAt", deleted_at AS "deletedAt", disabled_at AS "disabledAt", public_flags AS "publicFlags" FROM users WHERE id = $1`, [uid]);
    if (!u) throw notFound('User');
    const guilds = await ctx.db.query(`SELECT g.id, g.name, g.owner_id = $1 AS owner, m.joined_at AS "joinedAt" FROM members m JOIN guilds g ON g.id = m.guild_id
      WHERE m.user_id = $1 ORDER BY m.joined_at DESC LIMIT 200`, [uid]);
    const sessions = await ctx.db.query(`SELECT id, user_agent AS "userAgent", ip, created_at AS "createdAt", last_used_at AS "lastUsedAt"
      FROM sessions WHERE user_id = $1 AND NOT revoked AND expires_at > now() ORDER BY last_used_at DESC LIMIT 50`, [uid]);
    return { ...u, guilds, sessions };
  });

  /** Disable = block new logins + revoke every session + drop live gateway connections. The admin cannot disable themself. */
  app.post('/admin/users/:id/disable', async (req) => {
    gate(req);
    const { id: uid } = parse(id, req.params);
    if (uid === ctx.config.superAdminId) throw badRequest('The super admin account cannot be disabled');
    const [u] = await ctx.db.query('UPDATE users SET disabled_at = coalesce(disabled_at, now()) WHERE id = $1 RETURNING id', [uid]);
    if (!u) throw notFound('User');
    await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1', [uid]);
    ctx.hub.disconnectUser(uid);
    return { ok: true };
  });

  app.post('/admin/users/:id/enable', async (req) => {
    gate(req);
    const { id: uid } = parse(id, req.params);
    const [u] = await ctx.db.query('UPDATE users SET disabled_at = NULL WHERE id = $1 RETURNING id', [uid]);
    if (!u) throw notFound('User');
    return { ok: true };
  });

  /** Badges: replaces the user's public flag bitfield (unknown bits are rejected). The change is pushed to everyone who can see the user. */
  app.patch('/admin/users/:id/flags', async (req) => {
    gate(req);
    const { id: uid } = parse(id, req.params);
    const b = parse(z.object({ flags: z.number().int().min(0) }).strict(), req.body);
    if ((b.flags & ~ALL_USER_FLAGS) !== 0) throw badRequest('Unknown flag bits');
    const [row] = await ctx.db.query('UPDATE users SET public_flags = $2 WHERE id = $1 RETURNING *', [uid, b.flags]);
    if (!row) throw notFound('User');
    await adminAudit(ctx, req.userId, 'SET_USER_FLAGS', `/admin/users/${uid}/flags`, 200);
    await ctx.hub.toPresenceAudience(uid, 'USER_UPDATE', userDTO(ctx, row));
    return { ok: true, publicFlags: userDTO(ctx, row).publicFlags };
  });

  app.get('/admin/guilds', async (req) => {
    gate(req);
    const { q, limit, offset } = parse(page, req.query);
    return ctx.db.query(`SELECT g.id, g.name, g.created_at AS "createdAt", g.owner_id AS "ownerId", o.username AS "ownerName",
        (SELECT count(*) FROM members m WHERE m.guild_id = g.id)::int AS members,
        (SELECT count(*) FROM channels c WHERE c.guild_id = g.id)::int AS channels
      FROM guilds g LEFT JOIN users o ON o.id = g.owner_id WHERE ($1::text IS NULL OR g.name ILIKE $1 OR g.id = $4)
      ORDER BY g.created_at DESC LIMIT $2 OFFSET $3`, [like(q), limit, offset, q ?? null]);
  });

  app.get('/admin/guilds/:id', async (req) => {
    gate(req);
    const { id: gid } = parse(id, req.params);
    const [g] = await ctx.db.query(`SELECT g.id, g.name, g.description, g.created_at AS "createdAt", g.owner_id AS "ownerId", o.username AS "ownerName"
      FROM guilds g LEFT JOIN users o ON o.id = g.owner_id WHERE g.id = $1`, [gid]);
    if (!g) throw notFound('Guild');
    const channels = await ctx.db.query('SELECT id, name, type, parent_id AS "parentId", position FROM channels WHERE guild_id = $1 ORDER BY position, id', [gid]);
    const members = await ctx.db.query(`SELECT u.id, u.username, u.bot, m.nick, m.joined_at AS "joinedAt" FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.guild_id = $1 ORDER BY m.joined_at LIMIT 500`, [gid]);
    return { ...g, channels, members };
  });

  /** Read-only view of any channel's messages (guild or DM), newest first, paged with ?before=<messageId>. */
  app.get('/admin/channels/:id/messages', async (req) => {
    gate(req);
    const { id: cid } = parse(id, req.params);
    const { before, limit } = parse(z.object({ before: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    // Private conversations need the re-authenticated, time-boxed god mode and leave an audit row (guild channels stay read-only without it).
    const [ch] = await ctx.db.query('SELECT guild_id FROM channels WHERE id = $1', [cid]);
    if (!ch) throw notFound('Channel');
    if (!ch.guild_id) {
      if (!godModeUntil(ctx, req.userId)) throw badRequest('Turn on god mode to read direct messages');
      await adminAudit(ctx, req.userId, 'READ_DM', `/admin/channels/${cid}/messages`, 200);
    }
    const rows = await ctx.db.query(`SELECT m.id, m.content, m.edited_at AS "editedAt", m.author_id AS "authorId", u.username AS "authorName",
        jsonb_array_length(m.attachments) AS attachments
      FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.channel_id = $1 AND ($2::text IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3`, [cid, before ?? null, limit]);
    return rows.map((m: any) => ({ ...m, createdAt: new Date(snowflakeTime(m.id)).toISOString() }));
  });

  app.get('/admin/reports', async (req) => {
    gate(req);
    const { limit, offset } = parse(page, req.query);
    return ctx.db.query('SELECT * FROM reports ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
  });

  /**
   * God mode on/off. Turning it on re-checks the password (and the 2FA code when 2FA is on) so a stolen access token alone
   * cannot escalate. It expires after GOD_MODE_MS. Both transitions are audited.
   */
  app.post('/admin/god-mode', async (req) => {
    gate(req);
    const b = parse(z.object({ enabled: z.boolean(), password: z.string().max(128).optional(), totp: z.string().max(16).optional() }).strict(), req.body);
    if (b.enabled) {
      const key = `godmode:${req.userId}`;
      if (ctx.config.rateLimit && ctx.rl.isLimited(key, 5)) throw unauthorized('Too many attempts, try again later', 'RATE_LIMITED');
      const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
      const ok = !!row?.password_hash && !!b.password && (await verifyPassword(row.password_hash, b.password))
        && (!row.mfa_enabled || (!!b.totp && (await verifyTotp(ctx, row, b.totp))));
      if (!ok) { ctx.rl.hit(key, 5, 15 * 60_000); throw unauthorized(row?.mfa_enabled ? 'Password and 2FA code required' : 'Password required', 'REAUTH_FAILED'); }
    }
    const until = setGodMode(ctx, req.userId, b.enabled);
    await adminAudit(ctx, req.userId, b.enabled ? 'GOD_MODE_ON' : 'GOD_MODE_OFF', '/admin/god-mode', 200);
    return { godModeUntil: until ? new Date(until).toISOString() : null, durationMs: GOD_MODE_MS };
  });

  /** Join any server as the admin: skips invites, bans, screening and the server limit. Requires god mode. */
  app.post('/admin/guilds/:id/join', async (req) => {
    gate(req);
    const { id: gid } = parse(id, req.params);
    if (!godModeUntil(ctx, req.userId)) throw badRequest('Turn on god mode first');
    const [g] = await ctx.db.query('SELECT id FROM guilds WHERE id = $1', [gid]);
    if (!g) throw notFound('Guild');
    const added = await ctx.db.query('INSERT INTO members (guild_id, user_id, pending) VALUES ($1,$2,false) ON CONFLICT DO NOTHING RETURNING user_id', [gid, req.userId]);
    await ctx.pcache.invalidate({ k: 'member', guildId: gid, userId: req.userId });
    const full = await buildGuildFull(ctx, gid, req.userId);
    await ctx.hub.toUser(req.userId, 'GUILD_CREATE', full);
    if (added.length) { const m = await memberDTO(ctx, gid, req.userId); if (m) await ctx.hub.toGuild(gid, 'MEMBER_ADD', m, { exclude: req.userId }); }
    return { ok: true, joined: added.length > 0 };
  });

  app.get('/admin/audit', async (req) => {
    gate(req);
    const { limit, offset } = parse(page, req.query);
    return ctx.db.query('SELECT id, action, path, status, created_at AS "createdAt" FROM admin_audit ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
  });

  /** Mass-DM spam incidents (see services/massdm.ts): who was limited, why, for how long. */
  app.get('/admin/mass-dm', async (req) => {
    gate(req);
    const { limit, offset } = parse(page, req.query);
    return ctx.db.query(`SELECT i.id, i.sender_id AS "senderId", u.username, i.reason, i.recipients, i.sample, i.limited_until AS "limitedUntil", i.created_at AS "createdAt"
      FROM mass_dm_incidents i JOIN users u ON u.id = i.sender_id ORDER BY i.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  });
  app.post('/admin/users/:id/clear-dm-limit', async (req) => {
    gate(req);
    const { id: uid } = parse(id, req.params);
    const rows = await ctx.db.query('UPDATE users SET dm_limited_until = NULL WHERE id = $1 RETURNING id', [uid]);
    if (!rows.length) throw notFound('User');
    await ctx.db.query('DELETE FROM dm_request_events WHERE sender_id = $1', [uid]);
    return { ok: true };
  });
}
