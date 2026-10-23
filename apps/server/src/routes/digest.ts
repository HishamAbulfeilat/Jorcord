import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { notFound } from '../errors';
import { idSchema, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { entryDTO, getPrefs } from '../services/digest';

/** Quiet mode: digest preferences and the digest entries shown in the Inbox. The per-server / per-channel switch is `digest` on the notification-settings routes. */
export function digestRoutes(app: FastifyInstance, ctx: Ctx) {
  const unread = async (userId: string) => ((await ctx.db.query('SELECT count(*)::int AS n FROM digest_entries WHERE user_id = $1 AND read_at IS NULL', [userId]))[0]?.n ?? 0) as number;

  app.get('/users/@me/notification-digest', async (req) => ({ ...(await getPrefs(ctx, req.userId)), unread: await unread(req.userId) }));
  app.patch('/users/@me/notification-digest', async (req) => {
    const b = parse(z.object({ frequency: z.enum(['hourly', 'daily']), largeServerMentionsOnly: z.boolean() }).partial().strict(), req.body);
    limitOrThrow(ctx.rl, `digestset:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const cur = await getPrefs(ctx, req.userId);
    await ctx.db.query(
      `INSERT INTO notification_digest_prefs (user_id, frequency, large_server_mentions_only) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET frequency = $2, large_server_mentions_only = $3, updated_at = now()`,
      [req.userId, b.frequency ?? cur.frequency, b.largeServerMentionsOnly ?? cur.largeServerMentionsOnly]);
    return { ...(await getPrefs(ctx, req.userId)), unread: await unread(req.userId) };
  });

  /** Newest first. */
  app.get('/users/@me/digests', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().optional(), before: idSchema.optional() }), req.query);
    return (await ctx.db.query('SELECT * FROM digest_entries WHERE user_id = $1 AND ($2::text IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [req.userId, q.before ?? null, limitParam(q.limit, 25, 50)])).map(entryDTO);
  });
  app.post('/users/@me/digests/read', async (req, reply) => {
    await ctx.db.query('UPDATE digest_entries SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.userId]);
    return reply.code(204).send();
  });
  app.post('/users/@me/digests/:id/read', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const r = await ctx.db.query('UPDATE digest_entries SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
    if (!r.length) throw notFound('Digest');
    return reply.code(204).send();
  });
  app.delete('/users/@me/digests/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const r = await ctx.db.query('DELETE FROM digest_entries WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
    if (!r.length) throw notFound('Digest');
    return reply.code(204).send();
  });
}
