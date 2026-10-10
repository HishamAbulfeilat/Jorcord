import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';

interface Bucket { count: number; reset: number }
export interface ConsumeResult { limited: boolean; limit: number; remaining: number; resetAt: number; resetAfterSec: number; retryAfterSec: number }

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private timer = setInterval(() => { const n = Date.now(); for (const [k, b] of this.buckets) if (b.reset < n) this.buckets.delete(k); }, 30_000);
  constructor() { this.timer.unref(); }
  /** Counts one hit and reports the full bucket state (used for X-RateLimit-* headers). */
  consume(key: string, max: number, windowMs: number): ConsumeResult {
    const now = Date.now(); let b = this.buckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.count++;
    const limited = b.count > max;
    const after = Math.max(0, b.reset - now) / 1000;
    return { limited, limit: max, remaining: Math.max(0, max - b.count), resetAt: b.reset / 1000, resetAfterSec: after, retryAfterSec: limited ? after : 0 };
  }
  /** Returns seconds to wait when limited, else 0. */
  hit(key: string, max: number, windowMs: number): number {
    const r = this.consume(key, max, windowMs);
    return r.limited ? Math.ceil(r.resetAfterSec) : 0;
  }
  /** True when `key` already exceeded max within its active window (does not count a hit). */
  isLimited(key: string, max: number): boolean { const b = this.buckets.get(key); return !!b && b.reset > Date.now() && b.count >= max; }
  close() { clearInterval(this.timer); }
}

/** Stable opaque bucket id (never leaks the principal or resource ids). */
export const bucketId = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function rateLimitHeaders(r: ConsumeResult, bucket: string, scope?: 'user' | 'global' | 'shared'): Record<string, string> {
  return {
    'x-ratelimit-limit': String(r.limit), 'x-ratelimit-remaining': String(r.remaining), 'x-ratelimit-reset': r.resetAt.toFixed(3),
    'x-ratelimit-reset-after': r.resetAfterSec.toFixed(3), 'x-ratelimit-bucket': bucket,
    ...(r.limited ? { 'retry-after': String(Math.max(1, Math.ceil(r.retryAfterSec))), 'x-ratelimit-scope': scope ?? 'user', ...(scope === 'global' ? { 'x-ratelimit-global': 'true' } : {}) } : {}),
  };
}
export function rateLimitError(r: ConsumeResult, bucket: string, scope: 'user' | 'global' | 'shared' = 'user'): ApiError {
  const wait = Math.max(1, Math.ceil(r.retryAfterSec));
  return new ApiError(429, 'RATE_LIMITED', 'You are being rate limited', { retryAfter: wait }, rateLimitHeaders(r, bucket, scope))
    .with({ retry_after: Number(r.retryAfterSec.toFixed(3)), global: scope === 'global' });
}

export function limitOrThrow(rl: RateLimiter, key: string, max: number, windowMs: number, enabled = true) {
  if (!enabled) return;
  const r = rl.consume(key, max, windowMs);
  if (r.limited) throw rateLimitError(r, bucketId(key.split(':')[0] ?? key));
}

/** Per-route limits (max per window) for a principal; matched against "METHOD /route/pattern". First match wins. */
const ROUTE_LIMITS: { re: RegExp; max: number; windowMs: number }[] = [
  { re: /^POST \/api\/v1\/channels\/:id\/messages$/, max: 10, windowMs: 10_000 },
  { re: /^POST \/api\/v1\/interactions$/, max: 20, windowMs: 10_000 },
  { re: /^POST \/api\/v1\/interactions\/:id\/:token\//, max: 30, windowMs: 10_000 },
  { re: /^(POST|PUT) \/api\/v1\/oauth2\//, max: 10, windowMs: 60_000 },
  { re: /^POST \/api\/v1\/applications/, max: 10, windowMs: 60_000 },
  { re: /^(PUT|POST|PATCH|DELETE) \/api\/v1\/applications\/:id\/(guilds\/:gid\/)?commands/, max: 40, windowMs: 10_000 },
  { re: /^(POST|PUT|DELETE) \/api\/v1\/channels\/:id\/polls\//, max: 20, windowMs: 10_000 },
  { re: /^GET /, max: 120, windowMs: 10_000 },
  { re: /./, max: 40, windowMs: 10_000 },
];
const IP_GLOBAL = { max: 600, windowMs: 60_000 }, USER_GLOBAL = { max: 50, windowMs: 1000 }, INVALID_LIMIT = 10_000, INVALID_WINDOW = 10 * 60_000;

function principalOf(req: FastifyRequest): string {
  const a = req.headers.authorization;
  return a ? `t${createHash('sha256').update(a).digest('hex').slice(0, 20)}` : `i${req.ip}`;
}

/** Global (per IP and per credential), per-route bucket limits with X-RateLimit-* headers, auth-specific limits and an invalid-request ban. */
export function installRateLimit(app: FastifyInstance, rl: RateLimiter, enabled: boolean) {
  if (!enabled) return;
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/health') || req.url.startsWith('/api/v1/files/')) return;
    if (rl.isLimited(`inv:${req.ip}`, INVALID_LIMIT)) throw rateLimitError(rl.consume(`inv:${req.ip}`, INVALID_LIMIT, INVALID_WINDOW), 'invalid', 'global');
    const g = rl.consume(`g:${req.ip}`, IP_GLOBAL.max, IP_GLOBAL.windowMs);
    if (g.limited) throw rateLimitError(g, 'global', 'global');
    if (req.url.startsWith('/api/v1/auth/login') || req.url.startsWith('/api/v1/auth/register') || req.url.startsWith('/api/v1/auth/refresh'))
      limitOrThrow(rl, `a:${req.ip}`, 20, 60_000);
    if (!req.url.startsWith('/api/')) return;
    const principal = principalOf(req);
    if (req.headers.authorization) {
      const u = rl.consume(`ug:${principal}`, USER_GLOBAL.max, USER_GLOBAL.windowMs);
      if (u.limited) throw rateLimitError(u, 'global', 'global');
    }
    const pattern = req.routeOptions?.url ?? req.url.split('?')[0]!;
    const route = `${req.method} ${pattern}`;
    const lim = ROUTE_LIMITS.find((l) => l.re.test(route))!;
    const params = (req.params ?? {}) as Record<string, string>;
    const major = params.id ?? params.channelId ?? params.guildId ?? '';
    const r = rl.consume(`rb:${principal}:${route}:${major}`, lim.max, lim.windowMs);
    const id = bucketId(route);
    if (r.limited) throw rateLimitError(r, id, 'user');
    reply.headers(rateLimitHeaders(r, id));
  });
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode === 401 || reply.statusCode === 403 || reply.statusCode === 429) rl.consume(`inv:${req.ip}`, INVALID_LIMIT, INVALID_WINDOW);
  });
}
