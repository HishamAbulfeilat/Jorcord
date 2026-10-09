import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';

interface Bucket { count: number; reset: number }
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private timer = setInterval(() => { const n = Date.now(); for (const [k, b] of this.buckets) if (b.reset < n) this.buckets.delete(k); }, 30_000);
  constructor() { this.timer.unref(); }
  /** Returns seconds to wait when limited, else 0. */
  hit(key: string, max: number, windowMs: number): number {
    const now = Date.now(); let b = this.buckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.count++;
    return b.count > max ? Math.ceil((b.reset - now) / 1000) : 0;
  }
  /** True when `key` already exceeded max within its active window (does not count a hit). */
  isLimited(key: string, max: number): boolean { const b = this.buckets.get(key); return !!b && b.reset > Date.now() && b.count >= max; }
  close() { clearInterval(this.timer); }
}

export function limitOrThrow(rl: RateLimiter, key: string, max: number, windowMs: number, enabled = true) {
  if (!enabled) return;
  const wait = rl.hit(key, max, windowMs);
  if (wait) throw new ApiError(429, 'RATE_LIMITED', 'You are being rate limited', { retryAfter: wait }, { 'retry-after': String(wait) });
}

/** Global + auth-specific limits, keyed by client IP. */
export function installRateLimit(app: FastifyInstance, rl: RateLimiter, enabled: boolean) {
  if (!enabled) return;
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url.startsWith('/health') || req.url.startsWith('/api/v1/files/')) return;
    limitOrThrow(rl, `g:${req.ip}`, 600, 60_000);
    if (req.url.startsWith('/api/v1/auth/login') || req.url.startsWith('/api/v1/auth/register') || req.url.startsWith('/api/v1/auth/refresh'))
      limitOrThrow(rl, `a:${req.ip}`, 20, 60_000);
  });
}
