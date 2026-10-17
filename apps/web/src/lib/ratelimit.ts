/**
 * Client side of the server's rate limits (docs/CONTRACT.md "Errors, rate limits"):
 *  - 429 bodies carry `retry_after` (float seconds) and `details.retryAfter`; the header is `Retry-After`.
 *  - every response carries `X-RateLimit-Remaining|Reset-After|Bucket`, which lets us pause before the next call on an exhausted bucket.
 * Everything here is pure (injectable clock/sleep) so it can be unit-tested without a network.
 */

export interface RateLimitInfo { retryAfterMs: number; global: boolean; scope: string | null; bucket: string | null }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Best available "wait this long" for a 429, in ms. Body `retry_after` wins (it is fractional), then `details.retryAfter`, then the header. Defaults to 1s. */
export function retryAfterMs(body: unknown, headers?: { get(name: string): string | null }): number {
  const b = (body && typeof body === 'object' ? body : {}) as { retry_after?: unknown; details?: { retryAfter?: unknown } };
  const s = num(b.retry_after) ?? num(b.details?.retryAfter) ?? num(headers?.get('retry-after')) ?? 1;
  return Math.ceil(s * 1000);
}

export function parseRateLimit(status: number, body: unknown, headers?: { get(name: string): string | null }): RateLimitInfo | null {
  if (status !== 429) return null;
  const b = (body && typeof body === 'object' ? body : {}) as { global?: unknown };
  const global = b.global === true || headers?.get('x-ratelimit-global') === 'true';
  return { retryAfterMs: retryAfterMs(body, headers), global, scope: headers?.get('x-ratelimit-scope') ?? null, bucket: headers?.get('x-ratelimit-bucket') ?? null };
}

/** "You are being rate limited. Try again in 3 seconds." */
export function rateLimitMessage(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return `You are being rate limited. Try again in ${s} second${s === 1 ? '' : 's'}.`;
}

/** Collapses ids so one limiter bucket covers `/channels/123/messages` for any id of that route shape. */
export function routeKey(method: string, path: string): string {
  return method.toUpperCase() + ' ' + path.replace(/\/\d{5,}/g, '/:id').replace(/\/[A-Za-z0-9_-]{20,}/g, '/:token');
}

export interface LimiterOpts { now?: () => number; sleep?: (ms: number) => Promise<void>; maxAutoWaitMs?: number; maxRetries?: number; onWait?: (ms: number, why: 'bucket' | '429') => void }

/**
 * Remembers when each route (and the global bucket) may be called again. `before()` waits out a known pause,
 * `after()` records the headers of a response, and `handle429()` decides between waiting and retrying or giving up.
 */
export class Limiter {
  private pauseUntil = new Map<string, number>();
  private globalUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly maxAutoWaitMs: number;
  readonly maxRetries: number;
  /** Called when we are about to sleep (UI hint: "retrying in Ns"). */
  onWait?: LimiterOpts['onWait'];
  constructor(o: LimiterOpts = {}) {
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAutoWaitMs = o.maxAutoWaitMs ?? 8000;
    this.maxRetries = o.maxRetries ?? 2;
    this.onWait = o.onWait;
  }
  /** Milliseconds this route still has to wait (0 = go ahead). */
  pending(key: string): number { return Math.max(0, this.globalUntil - this.now(), (this.pauseUntil.get(key) ?? 0) - this.now()); }
  async before(key: string) {
    const w = this.pending(key);
    if (w > 0 && w <= this.maxAutoWaitMs) { this.onWait?.(w, 'bucket'); await this.sleep(w); }
  }
  /** Records `X-RateLimit-Remaining: 0` + `Reset-After` so the next call to the same route waits instead of earning a 429. */
  after(key: string, headers: { get(name: string): string | null }) {
    const remaining = num(headers.get('x-ratelimit-remaining')); const reset = num(headers.get('x-ratelimit-reset-after'));
    if (remaining === 0 && reset !== null) this.pauseUntil.set(key, this.now() + Math.ceil(reset * 1000));
    else if (remaining !== null && remaining > 0) this.pauseUntil.delete(key);
  }
  /** Returns true when the caller should retry (after we slept), false when the wait is too long and the error must surface. */
  async handle429(key: string, info: RateLimitInfo, attempt: number): Promise<boolean> {
    const until = this.now() + info.retryAfterMs;
    if (info.global) this.globalUntil = Math.max(this.globalUntil, until); else this.pauseUntil.set(key, until);
    if (attempt >= this.maxRetries || info.retryAfterMs > this.maxAutoWaitMs) return false;
    this.onWait?.(info.retryAfterMs, '429');
    await this.sleep(info.retryAfterMs);
    return true;
  }
}
