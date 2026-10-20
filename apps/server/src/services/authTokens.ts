import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { randomToken, sha256 } from '../lib/crypto';
import { actionEmail } from './emailTemplates';

export type TokenKind = 'verify_email' | 'reset_password';
const TTL_MS: Record<TokenKind, number> = { verify_email: 24 * 3600_000, reset_password: 3600_000 };
const webUrl = (ctx: Ctx, path: string) => `${ctx.config.publicUrl.replace(/\/$/, '')}${path}`;

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

/** True when the token can still be used (not consumed, not expired). Used by the reset page before asking for a password. */
export async function isAuthTokenUsable(ctx: Ctx, raw: string, kind: TokenKind): Promise<boolean> {
  const rows = await ctx.db.query(
    `SELECT 1 FROM auth_tokens WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()`, [sha256(raw), kind]);
  return rows.length > 0;
}

export async function sendVerificationEmail(ctx: Ctx, user: { id: string; email: string | null }) {
  if (!user.email) return;
  const token = await issueAuthToken(ctx, user.id, 'verify_email');
  const link = webUrl(ctx, `/verify-email?token=${encodeURIComponent(token)}`);
  await ctx.mailer.send({
    to: user.email,
    ...actionEmail({
      subject: 'Verify your Jorcord email',
      heading: 'Confirm your email',
      paragraphs: [
        'Welcome to Jorcord! Confirm this address so your account can be recovered if you forget your password.',
        'This link expires in 24 hours and works once.',
      ],
      action: { label: 'Verify email', url: link },
      footnote: ['If you did not create a Jorcord account, you can safely ignore this message.'],
    }),
  });
}

export async function sendPasswordResetEmail(ctx: Ctx, user: { id: string; email: string }) {
  const token = await issueAuthToken(ctx, user.id, 'reset_password');
  const link = webUrl(ctx, `/reset-password?token=${encodeURIComponent(token)}`);
  await ctx.mailer.send({
    to: user.email,
    ...actionEmail({
      subject: 'Reset your Jorcord password',
      heading: 'Reset your password',
      paragraphs: [
        'We received a request to reset the password for this Jorcord account.',
        'Choose a new password with the button below. The link expires in 1 hour and works once.',
      ],
      action: { label: 'Choose a new password', url: link },
      footnote: [
        'If you did not ask for this, ignore this email. Your password has not changed.',
        'Choosing a new password signs out every other device.',
      ],
    }),
  });
}

/** Security notice sent after a reset or an in-app password change. Never includes the password or a reset token. */
export async function sendPasswordChangedEmail(ctx: Ctx, user: { id: string; email: string }, when = new Date()) {
  await ctx.mailer.send({
    to: user.email,
    ...actionEmail({
      subject: 'Your Jorcord password was changed',
      heading: 'Your password was changed',
      paragraphs: [
        `The password for your Jorcord account was changed on ${when.toUTCString()}.`,
        'All other sessions have been signed out. You can sign in again with the new password.',
      ],
      action: { label: 'Reset your password', url: webUrl(ctx, '/forgot-password') },
      footnote: ['If you did not change your password, reset it now and review the security of your email account.'],
    }),
  });
}
