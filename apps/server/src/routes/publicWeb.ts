import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../ctx';
import { rateLimitHeaders } from '../lib/ratelimit';
import { PAGE_CSP, MAX_PAGE, cached, findPublicChannel, findPublicGuild, guildSitemap, notFound, renderChannel, renderGuildIndex, renderThread, robotsTxt, sitemapIndex, type Page } from '../services/publicWeb';

/** Per-IP budget for the crawlable pages: generous for search engines, small enough that one client cannot hammer the renderer. */
const PUBLIC_LIMIT = { max: 90, windowMs: 60_000 };

/**
 * Public, server-rendered, indexable pages (/p/...), sitemaps and robots.txt. No auth, no JS, GET/HEAD only.
 * Responses are cached in-process for 15s and by shared caches for 60s, so edits, deletions and un-publishing show up within about a minute.
 */
export async function publicWebRoutes(app: FastifyInstance, ctx: Ctx) {
  const limited = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!ctx.config.rateLimit) return false;
    const r = ctx.rl.consume(`pubweb:${req.ip}`, PUBLIC_LIMIT.max, PUBLIC_LIMIT.windowMs);
    if (!r.limited) return false;
    reply.headers(rateLimitHeaders(r, 'public-web')).code(429).type('text/plain; charset=utf-8').send('Too many requests');
    return true;
  };
  const pageNo = (q: unknown): number => { const n = Number((q as any)?.page); return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1; };

  async function send(req: FastifyRequest, reply: FastifyReply, key: string, build: () => Promise<Page>) {
    if (limited(req, reply)) return reply;
    const e = await cached(key, build);
    const p = e.page;
    reply.header('content-security-policy', PAGE_CSP).header('etag', e.etag).header('vary', 'accept-encoding');
    if (p.noindex) reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('cache-control', p.status === 200 ? 'public, max-age=60, stale-while-revalidate=300' : 'public, max-age=30');
    if (p.lastModified) reply.header('last-modified', p.lastModified.toUTCString());
    if (p.status === 200 && req.headers['if-none-match'] === e.etag) return reply.code(304).send();
    return reply.code(p.status).type(p.type ?? 'text/html; charset=utf-8').send(p.body);
  }

  app.get('/p/:guild', async (req, reply) => {
    const { guild } = req.params as { guild: string };
    return send(req, reply, `g:${guild.toLowerCase()}`, async () => {
      const g = await findPublicGuild(ctx, guild); return g ? renderGuildIndex(ctx, g) : notFound();
    });
  });
  app.get('/p/:guild/:channel', async (req, reply) => {
    const { guild, channel } = req.params as { guild: string; channel: string }; const page = pageNo(req.query);
    return send(req, reply, `c:${guild.toLowerCase()}:${channel}:${page}`, async () => {
      const g = await findPublicGuild(ctx, guild); if (!g) return notFound();
      const c = await findPublicChannel(ctx, g, channel); return c ? renderChannel(ctx, g, c, page) : notFound();
    });
  });
  app.get('/p/:guild/:channel/:thread', async (req, reply) => {
    const { guild, channel, thread } = req.params as { guild: string; channel: string; thread: string }; const page = pageNo(req.query);
    return send(req, reply, `t:${guild.toLowerCase()}:${channel}:${thread}:${page}`, async () => {
      const g = await findPublicGuild(ctx, guild); if (!g) return notFound();
      const c = await findPublicChannel(ctx, g, channel); return c ? renderThread(ctx, g, c, thread, page) : notFound();
    });
  });

  const plain = (reply: FastifyReply, type: string, body: string) =>
    reply.header('content-security-policy', "default-src 'none'").header('cache-control', 'public, max-age=300').type(type).send(body);
  app.get('/robots.txt', async (req, reply) => (limited(req, reply) ? reply : plain(reply, 'text/plain; charset=utf-8', robotsTxt(ctx))));
  app.get('/sitemap.xml', async (req, reply) => {
    if (limited(req, reply)) return reply;
    const e = await cached('sitemap-index', async () => ({ status: 200, body: await sitemapIndex(ctx) }));
    if (req.headers['if-none-match'] === e.etag) return reply.code(304).send();
    return reply.header('etag', e.etag).header('content-security-policy', "default-src 'none'").header('cache-control', 'public, max-age=300').type('application/xml; charset=utf-8').send(e.page.body);
  });
  app.get('/sitemaps/:file', async (req, reply) => {
    if (limited(req, reply)) return reply;
    const m = /^([A-Za-z0-9_-]{1,64})\.xml$/.exec((req.params as { file: string }).file);
    const e = m ? await cached(`sitemap:${m[1]!.toLowerCase()}`, async () => { const x = await guildSitemap(ctx, m[1]!); return x ? { status: 200, body: x } : notFound(); }) : null;
    if (!e || e.page.status !== 200) return reply.code(404).header('cache-control', 'public, max-age=30').type('text/plain; charset=utf-8').send('Not found');
    if (req.headers['if-none-match'] === e.etag) return reply.code(304).send();
    return reply.header('etag', e.etag).header('content-security-policy', "default-src 'none'").header('cache-control', 'public, max-age=300').type('application/xml; charset=utf-8').send(e.page.body);
  });
}
