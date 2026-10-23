import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONNECTION_PROVIDERS, MAX_CONNECTIONS, connectionProvider, isOAuthConnectionProvider, snowflake, type Connection, type ConnectionProviderInfo, type PublicConnection } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { safeGet } from '../lib/ssrf';
import { refreshUserEverywhere } from '../services/linkedroles';
import { BINDING_COOKIE, OAuthFlowError, STATE_TTL_SEC, completeAuthorize, disabled, oauthEnabled, parseCookie, startAuthorize } from '../services/connectionOAuth';

const codeOf = (token: string) => `jorcord-verify=${token}`;
export const connectionDTO = (r: any): Connection => ({ id: r.id, type: r.type, handle: r.handle, name: connectionProvider(r.type)?.name ?? r.type, url: r.url, verified: r.verified, visible: r.visible, createdAt: iso(r.created_at)!, verifyCode: codeOf(r.verify_token) });
export const publicConnection = (r: any): PublicConnection => ({ type: r.type, name: connectionProvider(r.type)?.name ?? r.type, url: r.url, verified: r.verified });

/** Visible connections of a user, verified ones first (used by GET /users/:id). */
export async function publicConnections(ctx: Ctx, userId: string): Promise<PublicConnection[]> {
  return (await ctx.db.query('SELECT * FROM connections WHERE user_id = $1 AND visible ORDER BY verified DESC, created_at LIMIT 20', [userId])).map(publicConnection);
}

/**
 * Profile connections. A connection is self-declared (an unverified link) until the owner proves control: put the connection's `verifyCode`
 * anywhere on the linked page (profile bio, site) and call verify; the server fetches it (SSRF-guarded) and looks for the code.
 * Twitch and YouTube can instead be verified with OAuth when the operator configured the app credentials (see services/connectionOAuth.ts).
 */
export function connectionRoutes(app: FastifyInstance, ctx: Ctx) {
  const idp = z.object({ id: idSchema });
  app.get('/connections/providers', async (): Promise<ConnectionProviderInfo[]> => CONNECTION_PROVIDERS.map((p) => ({ id: p.id, name: p.name, example: p.example, ...(oauthEnabled(ctx, p.id) ? { oauth: true } : {}) })));

  /** "Connect with Twitch / YouTube": returns the provider's authorize URL (501 FEATURE_DISABLED without server credentials). */
  app.post('/users/@me/connections/oauth/:provider/start', async (req, reply) => {
    const { provider } = parse(z.object({ provider: z.string().max(20) }), req.params);
    if (req.isBot) throw new ApiError(403, 'BOT_FORBIDDEN', 'Bots cannot add connections');
    if (!isOAuthConnectionProvider(provider)) throw badRequest('Unknown provider');
    if (!oauthEnabled(ctx, provider)) throw disabled(provider);
    limitOrThrow(ctx.rl, `connection-oauth:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const { url, nonce } = await startAuthorize(ctx, req.userId, provider);
    // The nonce ties the callback to this browser: a link forwarded to somebody else cannot attach their account to ours.
    reply.header('set-cookie', `${BINDING_COOKIE}=${nonce}; Max-Age=${STATE_TTL_SEC}; Path=/api/v1/connections/oauth; HttpOnly; SameSite=Lax${ctx.config.publicUrl.startsWith('https://') ? '; Secure' : ''}`);
    return { url, expiresIn: STATE_TTL_SEC };
  });
  app.get('/users/@me/connections', async (req) => (await ctx.db.query('SELECT * FROM connections WHERE user_id = $1 ORDER BY created_at', [req.userId])).map(connectionDTO));

  app.post('/users/@me/connections', async (req, reply) => {
    const b = parse(z.object({ type: z.string().max(20), handle: z.string().trim().min(1).max(200), visible: z.boolean().optional() }).strict(), req.body);
    if (req.isBot) throw new ApiError(403, 'BOT_FORBIDDEN', 'Bots cannot add connections');
    limitOrThrow(ctx.rl, `connection:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    const p = connectionProvider(b.type); if (!p) throw badRequest('Unknown provider');
    const handle = p.id === 'x' || p.id === 'github' ? b.handle.replace(/^@/, '') : b.handle;
    if (!p.pattern.test(handle)) throw badRequest(`That does not look like a ${p.name} ${p.id === 'website' ? 'https link' : 'handle'}`);
    if (p.id === 'website') { try { const u = new URL(handle); if (u.username || u.password) throw 0; } catch { throw badRequest('Enter a plain https link'); } }
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM connections WHERE user_id = $1', [req.userId]);
    if (n.n >= MAX_CONNECTIONS) throw new ApiError(400, 'LIMIT_REACHED', `You can have at most ${MAX_CONNECTIONS} connections`);
    const id = snowflake();
    try { await ctx.db.query('INSERT INTO connections (id, user_id, type, handle, url, visible, verify_token) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, req.userId, p.id, handle, p.url(handle), b.visible ?? true, randomBytes(9).toString('hex')]); }
    catch (e: any) { if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw new ApiError(409, 'ALREADY_CONNECTED', 'You already added that'); throw e; }
    return reply.code(201).send(connectionDTO((await ctx.db.query('SELECT * FROM connections WHERE id = $1', [id]))[0]));
  });

  app.patch('/users/@me/connections/:id', async (req) => {
    const { id } = parse(idp, req.params); const b = parse(z.object({ visible: z.boolean() }).strict(), req.body);
    const rows = await ctx.db.query('UPDATE connections SET visible = $3 WHERE id = $1 AND user_id = $2 RETURNING *', [id, req.userId, b.visible]);
    if (!rows.length) throw notFound('Connection');
    return connectionDTO(rows[0]);
  });
  app.delete('/users/@me/connections/:id', async (req, reply) => {
    const { id } = parse(idp, req.params);
    await ctx.db.query('DELETE FROM connections WHERE id = $1 AND user_id = $2', [id, req.userId]);
    return reply.code(204).send();
  });

  app.post('/users/@me/connections/:id/verify', async (req) => {
    const { id } = parse(idp, req.params);
    limitOrThrow(ctx.rl, `connection-verify:${req.userId}`, 6, 60_000, ctx.config.rateLimit);
    const [r] = await ctx.db.query('SELECT * FROM connections WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (!r) throw notFound('Connection');
    if (r.verified) return connectionDTO(r);
    let found = false;
    try {
      const res = await safeGet(r.url, { allowPrivate: ctx.config.allowPrivateUnfurl, maxBytes: 1_500_000 });
      found = res.status >= 200 && res.status < 300 && res.body.toString('utf8').includes(codeOf(r.verify_token));
    } catch { /* unreachable or blocked: treated as "not found" */ }
    if (!found) throw new ApiError(422, 'VERIFICATION_FAILED', `Could not find ${codeOf(r.verify_token)} on ${r.url}. Add it to the page (for example your bio) and try again.`);
    const [u] = await ctx.db.query('UPDATE connections SET verified = true WHERE id = $1 RETURNING *', [id]);
    void refreshUserEverywhere(ctx, req.userId).catch(() => {}); // linked roles that need a verified connection
    return connectionDTO(u);
  });
}

/** The provider redirects the browser here (no bearer token: the signed-in user comes from the stored state). Always answers with a redirect back to the web client. */
export function connectionOAuthPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  const back = (provider: string, result: string) => {
    const u = new URL('/channels/@me', ctx.config.publicUrl); u.searchParams.set('connect', provider); u.searchParams.set('result', result);
    return u.href;
  };
  app.get('/connections/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!isOAuthConnectionProvider(provider)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found' });
    reply.header('set-cookie', `${BINDING_COOKIE}=; Max-Age=0; Path=/api/v1/connections/oauth; HttpOnly; SameSite=Lax`).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    try { limitOrThrow(ctx.rl, `connection-oauth-cb:${req.ip}`, 30, 60_000, ctx.config.rateLimit); } catch { return reply.redirect(back(provider, 'rate_limited')); }
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (query.error) {
      // the user pressed "cancel": drop the pending state if we can tell which one it is
      const st = query.state; if (typeof st === 'string' && st.length <= 200) await ctx.db.query('DELETE FROM connection_oauth_states WHERE state_hash = $1', [createHash('sha256').update(st).digest('hex')]).catch(() => {});
      return reply.redirect(back(provider, 'denied'));
    }
    const q = z.object({ code: z.string().min(1).max(2048), state: z.string().min(16).max(200) }).safeParse(query);
    if (!q.success) return reply.redirect(back(provider, 'invalid_state'));
    try {
      await completeAuthorize(ctx, provider, { code: q.data.code, state: q.data.state, nonce: parseCookie(req.headers.cookie, BINDING_COOKIE) });
      return reply.redirect(back(provider, 'ok'));
    } catch (e) {
      if (e instanceof OAuthFlowError) return reply.redirect(back(provider, e.reason));
      ctx.log.error({ provider, err: e instanceof Error ? e.message : 'unknown' }, 'connection oauth callback failed');
      return reply.redirect(back(provider, 'exchange_failed'));
    }
  });
}
