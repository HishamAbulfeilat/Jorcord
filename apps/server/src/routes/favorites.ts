import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_GIF_FAVORITES, snowflake, type GifFavorite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';

const row = (r: any): GifFavorite => ({ id: r.id, url: r.url, preview: r.preview ?? null, title: r.title ?? null, width: r.width ?? null, height: r.height ?? null, createdAt: iso(r.created_at)! });
/** https only (plus this server's own uploads): a favorite is later rendered by the owner's client. */
const mediaUrl = z.string().max(2048).refine((s) => /^https:\/\/[^\s]+$/i.test(s) || /^\/api\/v1\/files\/[0-9a-f]{48}\/[^\s/?#]+$/.test(s), 'must be an https URL or one of your uploads');
const dim = z.number().int().min(1).max(10_000).nullable().optional();

/** GIF favorites / saved media: private, per user. */
export function favoriteRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/users/@me/gif-favorites', async (req) => (await ctx.db.query('SELECT * FROM gif_favorites WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [req.userId, MAX_GIF_FAVORITES])).map(row));

  /** Idempotent by URL: 201 when added, 200 with the existing row otherwise. */
  app.post('/users/@me/gif-favorites', async (req, reply) => {
    const b = parse(z.object({ url: mediaUrl, preview: mediaUrl.nullable().optional(), title: z.string().trim().max(120).nullable().optional(), width: dim, height: dim }).strict(), req.body);
    limitOrThrow(ctx.rl, `gif-fav:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const [have] = await ctx.db.query('SELECT * FROM gif_favorites WHERE user_id = $1 AND url = $2', [req.userId, b.url]);
    if (have) return reply.code(200).send(row(have));
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM gif_favorites WHERE user_id = $1', [req.userId]);
    if (n.n >= MAX_GIF_FAVORITES) throw new ApiError(400, 'LIMIT_REACHED', `You can keep at most ${MAX_GIF_FAVORITES} favorites`);
    const id = snowflake();
    await ctx.db.query('INSERT INTO gif_favorites (id, user_id, url, preview, title, width, height) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, url) DO NOTHING', [id, req.userId, b.url, b.preview ?? null, b.title ?? null, b.width ?? null, b.height ?? null]);
    const [r] = await ctx.db.query('SELECT * FROM gif_favorites WHERE user_id = $1 AND url = $2', [req.userId, b.url]);
    await ctx.hub.toUser(req.userId, 'GIF_FAVORITES_UPDATE', { item: row(r) });
    return reply.code(201).send(row(r));
  });

  app.delete('/users/@me/gif-favorites/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const rows = await ctx.db.query('DELETE FROM gif_favorites WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]); // somebody else's id is a silent no-op
    if (rows.length) await ctx.hub.toUser(req.userId, 'GIF_FAVORITES_UPDATE', { removedId: id });
    return reply.code(204).send();
  });
}
