import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { validatePushEndpoint } from '../services/push';
import { channelAccess, guildAccess } from '../services/perms';

const MAX_DEVICES_PER_USER = 20;

const subscription = z.object({
  endpoint: z.string().max(2048), expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
}).strict();
const registerBody = z.object({
  platform: z.enum(['web', 'android', 'ios', 'desktop']),
  token: z.string().min(8).max(1024).regex(/^[\x21-\x7e]+$/, 'invalid token').optional(),
  subscription: subscription.optional(),
}).strict();
const removeBody = z.object({ platform: z.enum(['web', 'android', 'ios', 'desktop']).optional(), token: z.string().max(2048).optional(), endpoint: z.string().max(2048).optional() }).strict();

const guildSettings = z.object({
  muted: z.boolean(), mutedUntil: z.string().datetime().nullable(), suppressEveryone: z.boolean(), suppressRoles: z.boolean(), level: z.enum(['all', 'mentions', 'none']).nullable(), digest: z.boolean(),
}).partial().strict();
const channelSettings = z.object({ muted: z.boolean(), mutedUntil: z.string().datetime().nullable(), digest: z.boolean() }).partial().strict();

const settingsRow = (r: any) => ({
  muted: !!r.muted, mutedUntil: iso(r.muted_until), suppressEveryone: !!r.suppress_everyone, suppressRoles: !!r.suppress_roles, level: (r.level ?? null) as 'all' | 'mentions' | 'none' | null, digest: !!r.digest,
});

export function pushPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  /** The VAPID application server key the browser needs for pushManager.subscribe(). Public by design. */
  app.get('/push/vapid-public-key', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return { publicKey: ctx.push.vapidPublicKey };
  });
}

export function pushRoutes(app: FastifyInstance, ctx: Ctx) {
  const deviceDTO = (d: any) => ({ id: d.id, platform: d.platform, createdAt: iso(d.created_at), lastUsedAt: iso(d.last_used_at), current: d.session_id === d.__current });

  app.post('/users/@me/push-devices', async (req, reply) => {
    limitOrThrow(ctx.rl, `pushreg:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const b = parse(registerBody, req.body);
    let token: string; let keys: { p256dh: string; auth: string } | null = null;
    if (b.platform === 'web' || b.platform === 'desktop') {
      if (!b.subscription) throw badRequest('A Web Push subscription is required for web and desktop devices');
      if (!validatePushEndpoint(b.subscription.endpoint)) throw badRequest('Invalid push endpoint');
      token = b.subscription.endpoint; keys = b.subscription.keys;
    } else {
      if (!b.token || b.subscription) throw badRequest('A device token is required for android and ios devices');
      token = b.token;
    }
    const id = snowflake();
    const [row] = await ctx.db.query(
      `INSERT INTO push_devices (id, user_id, platform, token, keys, session_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, keys = EXCLUDED.keys, session_id = EXCLUDED.session_id, last_used_at = now()
       RETURNING *`, [id, req.userId, b.platform, token, keys ? JSON.stringify(keys) : null, req.authSessionId]);
    // cap devices per user: forget the least recently used beyond the limit
    await ctx.db.query(
      `DELETE FROM push_devices WHERE id IN (SELECT id FROM push_devices WHERE user_id = $1 ORDER BY last_used_at DESC OFFSET $2)`, [req.userId, MAX_DEVICES_PER_USER]);
    return reply.code(201).send(deviceDTO({ ...row, __current: req.authSessionId }));
  });

  app.get('/users/@me/push-devices', async (req) => {
    const rows = await ctx.db.query('SELECT id, platform, session_id, created_at, last_used_at FROM push_devices WHERE user_id = $1 ORDER BY created_at', [req.userId]);
    return rows.map((r) => deviceDTO({ ...r, __current: req.authSessionId }));
  });

  /** Unregister by body/query {platform?, token | endpoint}; always scoped to the caller's own devices. Idempotent. */
  app.delete('/users/@me/push-devices', async (req, reply) => {
    const b = parse(removeBody, Object.keys((req.body as object) ?? {}).length ? req.body : req.query);
    const token = b.token ?? b.endpoint;
    if (!token) throw badRequest('token or endpoint required');
    await ctx.db.query('DELETE FROM push_devices WHERE user_id = $1 AND token = $2', [req.userId, token]);
    return reply.code(204).send();
  });
  app.delete('/users/@me/push-devices/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const rows = await ctx.db.query('DELETE FROM push_devices WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]); // user_id = IDOR guard
    if (!rows.length) throw notFound('Device');
    return reply.code(204).send();
  });

  // ---------- notification settings ----------
  const allSettings = async (userId: string) => {
    const [u] = await ctx.db.query('SELECT push_enabled FROM users WHERE id = $1', [userId]);
    const rows = await ctx.db.query('SELECT * FROM notification_settings WHERE user_id = $1', [userId]);
    return {
      pushEnabled: !!u?.push_enabled,
      guilds: rows.filter((r) => r.scope === 'guild').map((r) => ({ guildId: r.target_id as string, ...settingsRow(r) })),
      channels: rows.filter((r) => r.scope === 'channel').map((r) => ({ channelId: r.target_id as string, muted: !!r.muted, mutedUntil: iso(r.muted_until), digest: !!r.digest })),
    };
  };
  app.get('/users/@me/notification-settings', async (req) => allSettings(req.userId));
  app.patch('/users/@me/notification-settings', async (req) => {
    const b = parse(z.object({ pushEnabled: z.boolean() }).strict(), req.body);
    await ctx.db.query('UPDATE users SET push_enabled = $2 WHERE id = $1', [req.userId, b.pushEnabled]);
    return allSettings(req.userId);
  });

  async function upsert(userId: string, scope: 'guild' | 'channel', target: string, b: Record<string, unknown>) {
    const [cur] = await ctx.db.query('SELECT * FROM notification_settings WHERE user_id = $1 AND scope = $2 AND target_id = $3', [userId, scope, target]);
    const pick = <T>(k: string, col: string, def: T): T => (b[k] !== undefined ? (b[k] as T) : cur ? cur[col] : def);
    const muted = pick('muted', 'muted', false);
    // un-muting clears a pending timed mute; muting without a time is indefinite
    const mutedUntil = b.muted === false ? null : pick<string | null>('mutedUntil', 'muted_until', null);
    const [row] = await ctx.db.query(
      `INSERT INTO notification_settings (user_id, scope, target_id, muted, muted_until, suppress_everyone, suppress_roles, level, digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, scope, target_id) DO UPDATE SET muted = $4, muted_until = $5, suppress_everyone = $6, suppress_roles = $7, level = $8, digest = $9 RETURNING *`,
      [userId, scope, target, muted, mutedUntil, pick('suppressEveryone', 'suppress_everyone', false), pick('suppressRoles', 'suppress_roles', false), pick('level', 'level', null), pick('digest', 'digest', false)]);
    return row;
  }

  app.put('/users/@me/notification-settings/guilds/:guildId', async (req) => {
    const { guildId } = parse(z.object({ guildId: idSchema }), req.params);
    const b = parse(guildSettings, req.body);
    limitOrThrow(ctx.rl, `notifset:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    await guildAccess(ctx, req.userId, guildId); // must be a member (also stops row spam for arbitrary ids)
    return { guildId, ...settingsRow(await upsert(req.userId, 'guild', guildId, b)) };
  });
  app.put('/users/@me/notification-settings/channels/:channelId', async (req) => {
    const { channelId } = parse(z.object({ channelId: idSchema }), req.params);
    const b = parse(channelSettings, req.body);
    limitOrThrow(ctx.rl, `notifset:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    await channelAccess(ctx, req.userId, channelId);
    const r = await upsert(req.userId, 'channel', channelId, b);
    return { channelId, muted: !!r.muted, mutedUntil: iso(r.muted_until), digest: !!r.digest };
  });
  app.delete('/users/@me/notification-settings/:scope/:targetId', async (req, reply) => {
    const p = parse(z.object({ scope: z.enum(['guilds', 'channels']), targetId: idSchema }), req.params);
    await ctx.db.query('DELETE FROM notification_settings WHERE user_id = $1 AND scope = $2 AND target_id = $3', [req.userId, p.scope === 'guilds' ? 'guild' : 'channel', p.targetId]);
    return reply.code(204).send();
  });
}

