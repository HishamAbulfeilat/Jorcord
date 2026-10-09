import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { randomToken, sha256 } from '../lib/crypto';

export type TokenKind = 'verify_email' | 'reset_password';
const TTL_MS: Record<TokenKind, number> = { verify_email: 24 * 3600_000, reset_password: 3600_000 };

/** Issues a fresh one-time token (older unused tokens of the same kind are invalidated). Only its hash is stored. */
export async function issueAuthToken(ctx: Ctx, userId: string, kind: TokenKind): Promise<string> {
  const raw = randomToken(32);
  await ctx.db.query('DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2 AND used_at IS NULL', [userId, kind]);
  await ctx.db.query('INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [snowflake(), userId, kind, sha256(raw), new Date(Date.now() + TTL_MS[kind])]);
  return raw;
}

/** Atomically consumes a token (single use). Returns the user id, or null if unknown / used / expired. */
export async function consumeAuthToken(ctx: Ctx, raw: string, kind: TokenKind): Promise<string | null> {
  const rows = await ctx.db.query(
    'UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [sha256(raw), kind]);
  return rows[0]?.user_id ?? null;
}

export async function sendVerificationEmail(ctx: Ctx, user: { id: string; email: string | null }) {
  if (!user.email) return;
  const token = await issueAuthToken(ctx, user.id, 'verify_email');
  const link = `${ctx.config.publicUrl.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send({ to: user.email, subject: 'Verify your Jorcord email', text: `Welcome to Jorcord!\n\nConfirm your email address:\n${link}\n\nThis link expires in 24 hours. If you did not create an account you can ignore this message.` });
}

export async function sendPasswordResetEmail(ctx: Ctx, user: { id: string; email: string }) {
  const token = await issueAuthToken(ctx, user.id, 'reset_password');
  const link = `${ctx.config.publicUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send({ to: user.email, subject: 'Reset your Jorcord password', text: `Someone asked to reset the password of this Jorcord account.\n\nChoose a new password:\n${link}\n\nThis link expires in 1 hour and works once. If it was not you, ignore this message; your password has not changed.` });
}
