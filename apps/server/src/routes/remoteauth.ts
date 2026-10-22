import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, forbidden, notFound } from '../errors';
import { issueTokens } from '../auth';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';

/** QR-code login lives this long; after that the waiting device must create a fresh code. */
export const REMOTE_AUTH_TTL_MS = 2 * 60_000;

const secretSchema = z.string().min(20).max(100);
const gone = () => new ApiError(410, 'REMOTE_AUTH_EXPIRED', 'This QR code has expired');

/** Live row when `id` exists, is unexpired and `secret` matches the stored hash in `col`; otherwise throws (same error for unknown id and wrong secret). */
async function liveRow(ctx: Ctx, id: string, col: 'poll_hash' | 'scan_hash', secret: string) {
  const [r] = await ctx.db.query('SELECT * FROM remote_auth WHERE id = $1', [id]);
  if (!r || !safeEqual(r[col], sha256(secret))) throw notFound('QR login');
  if (r.status === 'consumed' || new Date(r.expires_at).getTime() < Date.now()) throw gone();
  return r;
}

/** Waiting device (not signed in): create a code, poll for the result. */
export function remoteAuthPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/auth/remote/create', async (req, reply) => {
    limitOrThrow(ctx.rl, `remote-create:${req.ip}`, 10, 5 * 60_000, ctx.config.rateLimit);
    const id = snowflake(), pollSecret = randomToken(24), scanSecret = randomToken(24);
    const expires = new Date(Date.now() + REMOTE_AUTH_TTL_MS);
    await ctx.db.query('INSERT INTO remote_auth (id, poll_hash, scan_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, sha256(pollSecret), sha256(scanSecret), String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip, expires]);
    // pollSecret stays on this device; only scanSecret goes into the QR code
    return reply.code(201).send({ id, pollSecret, scanSecret, expiresAt: expires.toISOString() });
  });

  app.post('/auth/remote/poll', async (req) => {
    limitOrThrow(ctx.rl, `remote-poll:${req.ip}`, 120, 60_000, ctx.config.rateLimit);
    const b = parse(z.object({ id: idSchema, pollSecret: secretSchema }).strict(), req.body);
    const r = await liveRow(ctx, b.id, 'poll_hash', b.pollSecret);
    if (r.status === 'denied') throw new ApiError(403, 'REMOTE_AUTH_DENIED', 'Login was declined on the other device');
    if (r.status !== 'approved') return { status: r.status as 'pending' | 'scanned', expiresAt: iso(r.expires_at) };
    // approved -> consumed is one atomic UPDATE: two racing polls can never both receive tokens
    const [won] = await ctx.db.query(`UPDATE remote_auth SET status = 'consumed' WHERE id = $1 AND status = 'approved' RETURNING user_id`, [b.id]);
    if (!won) throw gone();
    const [user] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [won.user_id]);
    if (!user || user.deleted_at) throw gone();
    return { status: 'approved' as const, ...(await issueTokens(ctx, user, req)) }; // a normal new session, listed under Devices
  });
}

/** Signed-in device (the phone): look at a scanned code, then approve or decline it. */
export function remoteAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/auth/remote/scan', async (req) => {
    if (req.isBot) throw forbidden('Bots cannot approve QR logins');
    limitOrThrow(ctx.rl, `remote-scan:${req.userId}`, 20, 5 * 60_000, ctx.config.rateLimit);
    const b = parse(z.object({ id: idSchema, scanSecret: secretSchema }).strict(), req.body);
    const r = await liveRow(ctx, b.id, 'scan_hash', b.scanSecret);
    if (r.status === 'approved' || r.status === 'denied') throw gone();
    if (r.status === 'scanned' && r.user_id !== req.userId) throw new ApiError(409, 'REMOTE_AUTH_TAKEN', 'This QR code was already scanned');
    // one atomic claim: a code first scanned by A can never be re-pointed at B by a racing request
    const claimed = await ctx.db.query(`UPDATE remote_auth SET status = 'scanned', user_id = $2 WHERE id = $1 AND (status = 'pending' OR (status = 'scanned' AND user_id = $2)) AND expires_at > now() RETURNING id`, [b.id, req.userId]);
    if (!claimed.length) throw new ApiError(409, 'REMOTE_AUTH_TAKEN', 'This QR code was already scanned');
    return { id: r.id, device: { userAgent: r.user_agent, ip: r.ip, createdAt: iso(r.created_at) }, expiresAt: iso(r.expires_at) };
  });

  app.post('/auth/remote/confirm', async (req, reply) => {
    if (req.isBot) throw forbidden('Bots cannot approve QR logins');
    limitOrThrow(ctx.rl, `remote-confirm:${req.userId}`, 20, 5 * 60_000, ctx.config.rateLimit);
    const b = parse(z.object({ id: idSchema, scanSecret: secretSchema, approve: z.boolean() }).strict(), req.body);
    const r = await liveRow(ctx, b.id, 'scan_hash', b.scanSecret);
    if (r.status !== 'scanned' || r.user_id !== req.userId) throw new ApiError(409, 'REMOTE_AUTH_NOT_SCANNED', 'Scan the QR code first');
    const [ok] = await ctx.db.query(`UPDATE remote_auth SET status = $3 WHERE id = $1 AND status = 'scanned' AND user_id = $2 AND expires_at > now() RETURNING id`, [b.id, req.userId, b.approve ? 'approved' : 'denied']);
    if (!ok) throw gone();
    return reply.code(204).send();
  });
}
