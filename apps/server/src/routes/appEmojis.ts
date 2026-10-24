import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_APPLICATION_EMOJIS, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, notFound } from '../errors';
import { assetUrl, idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { getApplication } from '../services/apps';
import { appEmojiDTO, lookupEmoji, storeEmojiDataUri } from '../services/appEmojis';

const nameSchema = z.string().regex(/^\w{2,32}$/);
const appParams = z.object({ app: idSchema });

/**
 * Application emoji: owned by an application, not a server. The application's bot token or its owner's session may manage them
 * (anyone else gets a 404). Any message the bot sends may use `<:name:id>` / `<a:name:id>`; clients resolve the image via `GET /emojis/:id`.
 */
export function appEmojiRoutes(app: FastifyInstance, ctx: Ctx) {
  async function manage(req: { userId: string; isBot: boolean; applicationId: string | null }, appId: string) {
    const row = await getApplication(ctx, appId);
    if (!row || !(req.isBot ? req.applicationId === appId : row.owner_id === req.userId)) throw notFound('Application');
    return row;
  }
  const load = async (appId: string, id: string) => {
    const [r] = await ctx.db.query('SELECT * FROM application_emojis WHERE id = $1 AND application_id = $2', [id, appId]);
    if (!r) throw notFound('Emoji');
    return r;
  };

  app.get('/applications/:app/emojis', async (req) => {
    const row = await manage(req, parse(appParams, req.params).app);
    return { items: (await ctx.db.query('SELECT * FROM application_emojis WHERE application_id = $1 ORDER BY id', [row.id])).map(appEmojiDTO) };
  });
  app.get('/applications/:app/emojis/:eid', async (req) => {
    const p = parse(appParams.extend({ eid: idSchema }), req.params);
    const row = await manage(req, p.app);
    return appEmojiDTO(await load(row.id, p.eid));
  });
  app.post('/applications/:app/emojis', async (req, reply) => {
    const row = await manage(req, parse(appParams, req.params).app);
    const b = parse(z.object({ name: nameSchema, image: z.string().max(400_000).optional(), url: assetUrl.optional(), animated: z.boolean().optional() }).strict(), req.body);
    if (!!b.image === !!b.url) throw badRequest('Provide exactly one of image (base64 data URI) or url (an uploaded file)');
    limitOrThrow(ctx.rl, `appemoji-create:${row.id}`, 30, 60_000, ctx.config.rateLimit);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM application_emojis WHERE application_id = $1', [row.id]);
    if (c.n >= MAX_APPLICATION_EMOJIS) throw new ApiError(400, 'MAX_EMOJIS', `An application can have at most ${MAX_APPLICATION_EMOJIS} emoji`);
    const img = b.image ? await storeEmojiDataUri(ctx, row.bot_user_id, b.image) : { url: b.url!, animated: b.animated ?? false };
    const id = snowflake();
    const [r] = await ctx.db.query('INSERT INTO application_emojis (id, application_id, name, animated, url) VALUES ($1,$2,$3,$4,$5) RETURNING *', [id, row.id, b.name, img.animated, img.url]);
    return reply.code(201).send(appEmojiDTO(r));
  });
  app.patch('/applications/:app/emojis/:eid', async (req) => {
    const p = parse(appParams.extend({ eid: idSchema }), req.params);
    const row = await manage(req, p.app);
    const b = parse(z.object({ name: nameSchema }).strict(), req.body);
    await load(row.id, p.eid);
    const [r] = await ctx.db.query('UPDATE application_emojis SET name = $3 WHERE id = $1 AND application_id = $2 RETURNING *', [p.eid, row.id, b.name]);
    return appEmojiDTO(r);
  });
  app.delete('/applications/:app/emojis/:eid', async (req, reply) => {
    const p = parse(appParams.extend({ eid: idSchema }), req.params);
    const row = await manage(req, p.app);
    await load(row.id, p.eid);
    await ctx.db.query('DELETE FROM application_emojis WHERE id = $1 AND application_id = $2', [p.eid, row.id]);
    return reply.code(204).send();
  });
}

/** Public: emoji images are loaded by `<img>` tags, which cannot send an Authorization header. Emoji ids are not secret. */
export function emojiPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  /** `/emojis/123.webp` redirects to the stored image; `/emojis/123` returns the emoji's metadata. */
  app.get('/emojis/:file', async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^\d{1,20}(?:\.(?:webp|gif|png|jpg))?$/) }), req.params);
    const [id, ext] = file.split('.') as [string, string | undefined];
    limitOrThrow(ctx.rl, `emoji-lookup:${req.ip}`, 600, 60_000, ctx.config.rateLimit);
    const e = await lookupEmoji(ctx, id);
    if (!e) throw notFound('Emoji');
    if (ext) return reply.header('cache-control', 'public, max-age=3600').redirect(e.url, 302);
    return e;
  });
}
