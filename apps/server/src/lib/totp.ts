import { authenticator } from 'otplib';
import type { Ctx } from '../ctx';
import { decryptSecret } from './crypto';
import { limitOrThrow } from './ratelimit';

authenticator.options = { window: 1, step: 30 };

/**
 * Verifies a TOTP code for a user row and burns its time step so the same code cannot be replayed (an observed code is
 * worthless after first use). Failures are throttled per user (5 per 15 min) on top of any per-route limits, so a
 * 6-digit code cannot be brute-forced even by an attacker who already knows the password.
 */
export async function verifyTotp(ctx: Ctx, user: { id: string; mfa_secret: string | null }, code: string): Promise<boolean> {
  const key = `totp-fail:${user.id}`;
  if (ctx.config.rateLimit && ctx.rl.isLimited(key, 5)) limitOrThrow(ctx.rl, key, 5, 15 * 60_000, true); // throws 429 with retry-after
  if (!user.mfa_secret) return false;
  let delta: number | null = null;
  try { delta = authenticator.checkDelta(code, decryptSecret(user.mfa_secret, ctx.config.jwtSecret)); } catch { delta = null; }
  if (delta === null) { if (ctx.config.rateLimit) ctx.rl.hit(key, 5, 15 * 60_000); return false; }
  const step = Math.floor(Date.now() / 30_000) + delta;
  const rows = await ctx.db.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2) RETURNING id', [user.id, step]);
  if (!rows.length) { if (ctx.config.rateLimit) ctx.rl.hit(key, 5, 15 * 60_000); return false; } // replay of an already-used code
  return true;
}
