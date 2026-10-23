import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import type { LockoutPolicy } from './ratelimit';

/**
 * Brute-force protection for secrets that are guessed in the URL (webhook tokens, invite codes), on top of the global limiter.
 * Only FAILED lookups count; a valid token / code never adds to a counter. Enough failures lock the key out, and each new lockout lasts twice as long as the last
 * (30 s, 1 min, 2 min ... up to 1 h). State is per node (like the rest of the rate limiter) and follows `config.rateLimit`.
 */
const MIN = 60_000;
export const WEBHOOK_IP_POLICY: LockoutPolicy = { max: 10, windowMs: 10 * MIN, baseLockMs: 30_000, maxLockMs: 60 * MIN };
/** One webhook id + the first characters of the token tried: repeated near-misses against a single hook. */
export const WEBHOOK_PREFIX_POLICY: LockoutPolicy = { max: 5, windowMs: 10 * MIN, baseLockMs: 30_000, maxLockMs: 60 * MIN };
export const INVITE_IP_POLICY: LockoutPolicy = { max: 20, windowMs: 10 * MIN, baseLockMs: 30_000, maxLockMs: 60 * MIN };
export const INVITE_USER_POLICY: LockoutPolicy = { max: 15, windowMs: 10 * MIN, baseLockMs: 30_000, maxLockMs: 60 * MIN };

export interface GuardKey { key: string; policy: LockoutPolicy }

export const webhookGuardKeys = (ip: string, id: string, token: string): GuardKey[] => [
  { key: `bf:wh:ip:${ip}`, policy: WEBHOOK_IP_POLICY },
  { key: `bf:wh:tok:${id}:${token.slice(0, 6)}`, policy: WEBHOOK_PREFIX_POLICY },
];
export const inviteGuardKeys = (ip: string, userId?: string): GuardKey[] => [
  { key: `bf:inv:ip:${ip}`, policy: INVITE_IP_POLICY },
  ...(userId ? [{ key: `bf:inv:user:${userId}`, policy: INVITE_USER_POLICY }] : []),
];

/** 429 (with Retry-After) while any of the keys is locked out. Counts nothing. */
export function assertNotLocked(ctx: Ctx, keys: GuardKey[]) {
  if (!ctx.config.rateLimit) return;
  const wait = Math.max(0, ...keys.map((k) => ctx.rl.lockedFor(k.key)));
  if (wait > 0) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.', { retryAfter: wait }, { 'retry-after': String(wait) }).with({ retry_after: wait, global: false });
}

/** Counts one failed guess against every key. */
export function recordFailure(ctx: Ctx, keys: GuardKey[]) {
  if (!ctx.config.rateLimit) return;
  for (const k of keys) {
    const lock = ctx.rl.recordFailure(k.key, k.policy);
    if (lock) ctx.log.warn({ lockSeconds: lock, bucket: k.key.split(':').slice(0, 3).join(':') }, 'brute-force lockout');
  }
}
