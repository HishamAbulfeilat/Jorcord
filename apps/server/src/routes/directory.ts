import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DIRECTORY_CATEGORIES, DIRECTORY_CATEGORY_IDS, type DirectoryApp, type DirectoryCategory } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { notFound } from '../errors';
import { idSchema, iso, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';

const INSTALLS = `(SELECT count(*)::int FROM application_installs i WHERE i.application_id = a.id AND i.scopes ? 'bot')`;
const LISTED = 'a.directory_listed AND a.bot_public';
export const directoryDTO = (r: any): DirectoryApp => ({
  id: r.id, name: r.name, summary: r.directory_summary || String(r.description ?? '').slice(0, 140), description: r.description ?? '', icon: r.icon ?? null, botUserId: r.bot_user_id,
  category: (r.directory_category ?? 'other') as DirectoryCategory, tags: r.directory_tags ?? [], installs: r.installs ?? 0, official: !!r.system_key, permissions: r.directory_permissions ?? '0', listedAt: iso(r.directory_listed_at ?? r.created_at)!,
});

/**
 * App Directory: public bots whose owners opted in. Read-only; installing goes through the existing OAuth2 add-bot flow
 * (`/oauth2/authorize?client_id=...&scope=bot applications.commands&permissions=...`), which checks the installer's MANAGE_GUILD.
 * Only name, summaries, icon, category, tags, install count and suggested permissions are exposed: never owners, secrets or endpoints.
 */
export function directoryRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/directory/categories', async (req) => {
    limitOrThrow(ctx.rl, `directory:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const rows = await ctx.db.query(`SELECT a.directory_category AS id, count(*)::int AS n FROM applications a WHERE ${LISTED} GROUP BY a.directory_category`);
    return DIRECTORY_CATEGORIES.map((c) => ({ id: c.id, name: c.name, count: rows.find((r) => r.id === c.id)?.n ?? 0 }));
  });

  app.get('/directory/apps', async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), category: z.enum(DIRECTORY_CATEGORY_IDS).optional(), sort: z.enum(['popular', 'new']).default('popular'), limit: z.coerce.number().optional(), offset: z.coerce.number().int().min(0).max(10_000).default(0) }), req.query);
    limitOrThrow(ctx.rl, `directory:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const where = `${LISTED} AND ($1::text IS NULL OR a.directory_category = $1) AND ($2::text IS NULL OR a.name ILIKE $2 OR a.directory_summary ILIKE $2 OR a.description ILIKE $2 OR a.directory_tags::text ILIKE $2)`;
    const [t] = await ctx.db.query(`SELECT count(*)::int AS n FROM applications a WHERE ${where}`, [q.category ?? null, like]);
    const rows = await ctx.db.query(`SELECT a.*, ${INSTALLS} AS installs FROM applications a WHERE ${where} ORDER BY (a.system_key IS NOT NULL) DESC, ${q.sort === 'new' ? 'a.directory_listed_at DESC NULLS LAST' : 'installs DESC, a.directory_listed_at DESC NULLS LAST'}, a.id LIMIT $3 OFFSET $4`, [q.category ?? null, like, limitParam(q.limit, 24, 50), q.offset]);
    return { items: rows.map(directoryDTO), total: t.n };
  });

  app.get('/directory/apps/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    limitOrThrow(ctx.rl, `directory:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const [r] = await ctx.db.query(`SELECT a.*, ${INSTALLS} AS installs FROM applications a WHERE a.id = $1 AND ${LISTED}`, [id]);
    if (!r) throw notFound('App');
    return directoryDTO(r);
  });
}
