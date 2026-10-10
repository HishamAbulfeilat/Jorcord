import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONNECTION_PROVIDERS, MAX_CONNECTIONS, connectionProvider, snowflake, type Connection, type PublicConnection } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { safeGet } from '../lib/ssrf';
import { refreshUserEverywhere } from '../services/linkedroles';

const codeOf = (token: string) => `jorcord-verify=${token}`;
export const connectionDTO = (r: any): Connection => ({ id: r.id, type: r.type, handle: r.handle, name: connectionProvider(r.type)?.name ?? r.type, url: r.url, verified: r.verified, visible: r.visible, createdAt: iso(r.created_at)!, verifyCode: codeOf(r.verify_token) });
export const publicConnection = (r: any): PublicConnection => ({ type: r.type, name: connectionProvider(r.type)?.name ?? r.type, url: r.url, verified: r.verified });

/** Visible connections of a user, verified ones first (used by GET /users/:id). */
export async function publicConnections(ctx: Ctx, userId: string): Promise<PublicConnection[]> {
  return (await ctx.db.query('SELECT * FROM connections WHERE user_id = $1 AND visible ORDER BY verified DESC, created_at LIMIT 20', [userId])).map(publicConnection);
}

/**
 * Profile connections. Jorcord does not integrate with third-party OAuth, so a connection is self-declared (an unverified link) until the owner
 * proves control: put the connection's `verifyCode` anywhere on the linked page (profile bio, site) and call verify; the server fetches it
 * (SSRF-guarded) and looks for the code.
 */
export function connectionRoutes(app: FastifyInstance, ctx: Ctx) {
  const idp = z.object({ id: idSchema });
  app.get('/connections/providers', async () => CONNECTION_PROVIDERS.map((p) => ({ id: p.id, name: p.name, example: p.example })));
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
