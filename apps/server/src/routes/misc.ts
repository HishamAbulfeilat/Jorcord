import type { FastifyInstance } from 'fastify';
import { AccessToken, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { z } from 'zod';
import { LIMITS, Perm, has, type VoiceToken } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { isInlineType, saveUpload } from '../services/files';
import { unfurl } from '../services/unfurl';
import { channelAccess } from '../services/perms';
import { VOICE_TYPES, clearVoiceState, loadModeration, voiceCaps } from '../services/voice';

export function fileRoutes(app: FastifyInstance, ctx: Ctx) {
  // Public, unguessable-key download endpoint with range support.
  app.get('/files/:key/:filename', async (req, reply) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-f0-9]{48}$/), filename: z.string().max(600) }), req.params);
    const [f] = await ctx.db.query('SELECT * FROM files WHERE key = $1', [key]);
    if (!f) throw notFound('File');
    const size = Number(f.size);
    const inline = isInlineType(f.content_type);
    reply.headers({
      'content-type': inline ? f.content_type : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename).replace(/['()]/g, escape)}`,
      'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'cross-origin',
    });
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0, end = size - 1, ok = !!m && (m[1] !== '' || m[2] !== '');
      if (m && ok) {
        if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
        ok = start <= end && start < size;
      }
      if (!ok) return reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(ctx.storage.get(key, { start, end }));
    }
    return reply.header('content-length', size).send(ctx.storage.get(key));
  });
}

export function miscRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/uploads', async (req, reply) => {
    limitOrThrow(ctx.rl, `upload:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    if (!req.isMultipart()) throw badRequest('multipart/form-data required');
    let result: Awaited<ReturnType<typeof saveUpload>> | null = null;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (result) throw badRequest('Send one file per request');
      result = await saveUpload(ctx, req.userId, part);
    }
    if (!result) throw badRequest('No file provided');
    return reply.code(201).send(result);
  });

  const cache = new Map<string, { at: number; v: unknown }>();
  const cached = <T>(k: string, ttl: number): T | undefined => { const e = cache.get(k); return e && Date.now() - e.at < ttl ? (e.v as T) : undefined; };
  const put = (k: string, v: unknown) => { if (cache.size > 500) cache.delete(cache.keys().next().value!); cache.set(k, { at: Date.now(), v }); };

  app.get('/unfurl', async (req) => {
    const { url } = parse(z.object({ url: z.string().url().max(2048) }), req.query);
    limitOrThrow(ctx.rl, `unfurl:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    if (!/^https?:\/\//i.test(url)) throw badRequest('Only http(s) URLs');
    const hit = cached<any>(`u:${url}`, 600_000);
    const embed = hit !== undefined ? hit : await unfurl(ctx, url);
    put(`u:${url}`, embed);
    if (!embed) throw notFound('Preview');
    return embed;
  });

  const gifs = async (kind: 'search' | 'trending', q: string | undefined) => {
    const key = `g:${kind}:${q ?? ''}`;
    const hit = cached<any[]>(key, 60_000); if (hit) return hit;
    let items: any[] = [];
    try {
      if (ctx.config.tenorKey) {
        const u = new URL(`https://tenor.googleapis.com/v2/${kind === 'search' ? 'search' : 'featured'}`);
        u.searchParams.set('key', ctx.config.tenorKey); u.searchParams.set('limit', '30'); u.searchParams.set('media_filter', 'gif,tinygif');
        if (q) u.searchParams.set('q', q);
        const j: any = await (await fetch(u, { signal: AbortSignal.timeout(5000) })).json();
        items = (j.results ?? []).map((r: any) => ({ id: r.id, title: r.content_description ?? '', url: r.media_formats?.gif?.url, previewUrl: r.media_formats?.tinygif?.url, width: r.media_formats?.gif?.dims?.[0] ?? null, height: r.media_formats?.gif?.dims?.[1] ?? null }));
      } else if (ctx.config.giphyKey) {
        const u = new URL(`https://api.giphy.com/v1/gifs/${kind}`);
        u.searchParams.set('api_key', ctx.config.giphyKey); u.searchParams.set('limit', '30'); if (q) u.searchParams.set('q', q);
        const j: any = await (await fetch(u, { signal: AbortSignal.timeout(5000) })).json();
        items = (j.data ?? []).map((r: any) => ({ id: r.id, title: r.title ?? '', url: r.images?.original?.url, previewUrl: r.images?.fixed_width_small?.url ?? r.images?.fixed_width?.url, width: Number(r.images?.original?.width) || null, height: Number(r.images?.original?.height) || null }));
      }
    } catch (e) { ctx.log.warn({ err: e }, 'gif provider failed'); return []; }
    items = items.filter((i) => typeof i.url === 'string' && i.url.startsWith('https://'));
    put(key, items);
    return items;
  };
  app.get('/gifs/search', async (req) => { const { q } = parse(z.object({ q: z.string().min(1).max(100) }), req.query); return gifs('search', q); });
  app.get('/gifs/trending', async () => gifs('trending', undefined));

  // ---------- voice ----------
  app.post('/voice/token', async (req) => {
    const { channelId } = parse(z.object({ channelId: idSchema }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, channelId);
    if (!VOICE_TYPES.includes(a.channel.type)) throw badRequest('Not a voice channel');
    if (!has(a.perms, Perm.CONNECT)) throw forbidden('Missing permissions');
    const prev = await ctx.voice.get(req.userId);
    const already = prev?.channelId === channelId;
    const n = (await ctx.voice.inChannel(channelId)).length;
    if (!already && n >= Math.min(a.channel.user_limit || LIMITS.maxVoiceUsers, a.channel.type === 'stage' ? LIMITS.maxStageSeats : LIMITS.maxVoiceUsers)) throw new ApiError(409, 'CHANNEL_FULL', 'Voice channel is full');
    const [u] = await ctx.db.query('SELECT username, display_name FROM users WHERE id = $1', [req.userId]);
    // server mute/deafen and stage suppression are enforced in the token itself, not just in the UI
    const mod = already ? { mute: prev!.serverMute, deaf: prev!.serverDeaf } : await loadModeration(ctx, a.channel.guild_id ?? null, req.userId);
    const caps = voiceCaps(a.channel, a.perms, { serverMute: mod.mute, serverDeaf: mod.deaf, suppress: a.channel.type === 'stage' && (already ? prev!.suppress : !has(a.perms, Perm.MUTE_MEMBERS)) });
    const sources = [...(caps.canSpeak ? [TrackSource.MICROPHONE] : []), ...(caps.canStream ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [])];
    const at = new AccessToken(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret, { identity: req.userId, name: u.display_name ?? u.username, ttl: '6h', metadata: JSON.stringify({ userId: req.userId }) });
    at.addGrant({ roomJoin: true, room: channelId, canSubscribe: caps.canSubscribe, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: true, canUpdateOwnMetadata: true });
    const out: VoiceToken = { token: await at.toJwt(), url: ctx.config.livekit.url, room: channelId };
    return out;
  });
}

/** LiveKit webhook receiver: keeps gateway voice state honest if a client vanishes without leaving. */
export function voiceWebhookRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const receiver = new WebhookReceiver(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret);
  app.post('/voice/webhook', async (req, reply) => {
    if (typeof req.body !== 'string') throw badRequest('Expected application/webhook+json');
    let event;
    try { event = await receiver.receive(req.body, req.headers.authorization); }
    catch { throw new ApiError(401, 'UNAUTHORIZED', 'Invalid webhook signature'); }
    if (event.event === 'participant_left' && event.participant?.identity) {
      const st = await ctx.voice.get(event.participant.identity);
      if (st && st.channelId === event.room?.name) await clearVoiceState(ctx, event.participant.identity);
    }
    return reply.code(200).send({ ok: true });
  });
}
