import { USERNAME_CHANGE_LIMIT, USERNAME_RE, snowflake, type UsernameChangeResult } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, unauthorized } from '../errors';
import { randomToken, sha256, verifyPassword } from '../lib/crypto';
import { limitOrThrow } from '../lib/ratelimit';
import { verifyTotp } from '../lib/totp';
import { dropPushDevices } from './pushDevices';
import { actionEmail } from './emailTemplates';
import { checkImpersonation } from './impersonation';
import { checkMemberProfileEverywhere } from './automod';
import { selfUserDTO, userDTO } from './serializers';

const DAY = 86_400_000;
const webUrl = (ctx: Ctx, path: string) => `${ctx.config.publicUrl.replace(/\/$/, '')}${path}`;
const EMAIL_CHANGE_TTL_MS = 24 * 3600_000;

/** Password (and, with two-factor on, an authenticator code) check shared by every sensitive account change. Throws 401. */
export async function confirmIdentity(ctx: Ctx, user: any, password: string, totp?: string) {
  if (!user?.password_hash || !(await verifyPassword(user.password_hash, password))) throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  if (user.mfa_enabled) {
    if (!totp) throw new ApiError(401, 'MFA_REQUIRED', 'A valid two-factor code is required');
    if (!(await verifyTotp(ctx, user, totp))) throw new ApiError(401, 'INVALID_CODE', 'Invalid authentication code');
  }
}

// ---------------------------------------------------------------- username
/** How many username changes are left in the rolling window, and when the next one opens up. */
export async function usernameStatus(ctx: Ctx, userId: string): Promise<{ changesLeft: number; nextChangeAt: string | null }> {
  const { changes, windowDays } = USERNAME_CHANGE_LIMIT;
  const rows = await ctx.db.query(`SELECT changed_at FROM username_history WHERE user_id = $1 AND changed_at > now() - ($2::int * interval '1 day') ORDER BY changed_at`, [userId, windowDays]);
  const left = Math.max(0, changes - rows.length);
  return { changesLeft: left, nextChangeAt: left > 0 || !rows.length ? null : new Date(new Date(rows[rows.length - changes]!.changed_at).getTime() + windowDays * DAY).toISOString() };
}

/** True when `name` is somebody else's recently released handle. */
export async function isReservedForOther(ctx: Ctx, name: string, userId: string | null): Promise<boolean> {
  const [r] = await ctx.db.query('SELECT user_id FROM reserved_usernames WHERE username = $1 AND reserved_until > now()', [name.toLowerCase()]);
  return !!r && r.user_id !== userId;
}

export async function changeUsername(ctx: Ctx, userId: string, input: { username: string; password: string; totp?: string }): Promise<UsernameChangeResult> {
  limitOrThrow(ctx.rl, `username-change:${userId}`, 6, 15 * 60_000, ctx.config.rateLimit); // password-guessing brake
  const name = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) throw badRequest('username must be 2-32 chars: a-z 0-9 _ .');
  const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!u || u.bot) throw badRequest('Bots cannot change their username here');
  await confirmIdentity(ctx, u, input.password, input.totp);
  if (u.username.toLowerCase() === name) throw badRequest('That is already your username', { field: 'username' });
  const st = await usernameStatus(ctx, userId);
  if (st.changesLeft <= 0) throw new ApiError(429, 'USERNAME_COOLDOWN', `You can change your username ${USERNAME_CHANGE_LIMIT.changes} times every ${USERNAME_CHANGE_LIMIT.windowDays} days`, { nextChangeAt: st.nextChangeAt }).with({ nextChangeAt: st.nextChangeAt });
  const taken = () => new ApiError(409, 'USERNAME_TAKEN', 'That username is not available');
  if (await isReservedForOther(ctx, name, userId)) throw taken();
  const old = u.username.toLowerCase();
  try {
    await ctx.db.tx(async (q) => {
      await q.query('UPDATE users SET username = $2, username_changed_at = now() WHERE id = $1', [userId, name]);
      await q.query('INSERT INTO username_history (id, user_id, old_username, new_username) VALUES ($1,$2,$3,$4)', [snowflake(), userId, old, name]);
      await q.query('DELETE FROM reserved_usernames WHERE username = $1 AND user_id = $2', [name, userId]); // taking back one's own handle
      await q.query(
        `INSERT INTO reserved_usernames (username, user_id, reserved_until) VALUES ($1,$2,$3)
         ON CONFLICT (username) DO UPDATE SET user_id = EXCLUDED.user_id, reserved_until = EXCLUDED.reserved_until`, [old, userId, new Date(Date.now() + USERNAME_CHANGE_LIMIT.reserveDays * DAY)]);
    });
  } catch (e: any) {
    if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw taken();
    throw e;
  }
  await ctx.pcache.invalidate({ k: 'user', userId });
  const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [userId]);
  // a new handle is checked against the owner/staff names of every server that has the impersonation guard on
  const gs = await ctx.db.query(`SELECT m.guild_id FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 AND g.impersonation_guard->>'enabled' = 'true' LIMIT 100`, [userId]);
  for (const g of gs) await checkImpersonation(ctx, g.guild_id, userId).catch((e) => ctx.log.warn({ err: e }, 'impersonation check failed'));
  await checkMemberProfileEverywhere(ctx, userId);
  await ctx.hub.toPresenceAudience(userId, 'USER_UPDATE', userDTO(ctx, row));
  await ctx.hub.toUser(userId, 'USER_UPDATE', selfUserDTO(ctx, row) as any); // the account's other sessions pick up the new handle at once
  const after = await usernameStatus(ctx, userId);
  return { user: selfUserDTO(ctx, row), changesLeft: after.changesLeft, nextChangeAt: after.nextChangeAt };
}

/** Housekeeping for the sweeper: released handles past their reservation. */
export async function pruneReservedUsernames(ctx: Ctx) {
  await ctx.db.query('DELETE FROM reserved_usernames WHERE reserved_until < now()');
}

// ---------------------------------------------------------------- email
export interface PendingEmailChange { pendingEmail: string; expiresAt: string }

export async function pendingEmailChange(ctx: Ctx, userId: string): Promise<PendingEmailChange | null> {
  const [r] = await ctx.db.query('SELECT new_email, expires_at FROM email_changes WHERE user_id = $1 AND expires_at > now()', [userId]);
  return r ? { pendingEmail: r.new_email, expiresAt: new Date(r.expires_at).toISOString() } : null;
}

/**
 * Starts an email change: the new address gets a confirm link (the credential), the current address gets a notice. Nothing changes until the link is used.
 * An address that already belongs to another account answers exactly like a free one (no account enumeration) but sends nothing to the new address.
 */
export async function requestEmailChange(ctx: Ctx, userId: string, input: { newEmail: string; password: string; totp?: string }): Promise<PendingEmailChange> {
  limitOrThrow(ctx.rl, `email-change:${userId}`, 5, 3600_000, ctx.config.rateLimit);
  const email = input.newEmail.trim().toLowerCase();
  const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!u || u.bot) throw badRequest('Bots have no email address');
  await confirmIdentity(ctx, u, input.password, input.totp);
  if (u.email && u.email.toLowerCase() === email) throw badRequest('That is already your email address', { field: 'newEmail' });
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);
  const [clash] = await ctx.db.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (clash) return { pendingEmail: email, expiresAt: expiresAt.toISOString() }; // indistinguishable from success
  const token = randomToken(32);
  await ctx.db.query(
    `INSERT INTO email_changes (user_id, new_email, token_hash, expires_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET new_email = EXCLUDED.new_email, token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, created_at = now()`, [userId, email, sha256(token), expiresAt]);
  try {
    await ctx.mailer.send({
      to: email,
      ...actionEmail({
        subject: 'Confirm your new Jorcord email',
        heading: 'Confirm your new email address',
        paragraphs: ['Someone asked to use this address for a Jorcord account. Confirm it to finish the change.', 'This link expires in 24 hours and works once. Confirming signs you out of every device.'],
        action: { label: 'Confirm email', url: webUrl(ctx, `/verify-email-change?token=${encodeURIComponent(token)}`) },
        footnote: ['If you did not ask for this, ignore this message. Nothing changes until the link is used.'],
      }),
    });
  } catch (e) {
    await ctx.db.query('DELETE FROM email_changes WHERE user_id = $1', [userId]);
    ctx.log.warn({ err: e }, 'email change confirmation mail failed');
    throw new ApiError(503, 'MAIL_FAILED', 'We could not send the confirmation email. Try again later.');
  }
  if (u.email) {
    void ctx.mailer.send({
      to: u.email,
      ...actionEmail({
        subject: 'A new email address was requested for your Jorcord account',
        heading: 'Email change requested',
        paragraphs: [`A change of your account email to ${email} was requested. Your address stays ${u.email} until the new one is confirmed.`],
        action: { label: 'Not you? Reset your password', url: webUrl(ctx, '/forgot-password') },
        footnote: ['If you did not ask for this, change your password now and review the security of your email account.'],
      }),
    }).catch((e) => ctx.log.warn({ err: e }, 'email change notice failed'));
  }
  return { pendingEmail: email, expiresAt: expiresAt.toISOString() };
}

export async function cancelEmailChange(ctx: Ctx, userId: string) {
  await ctx.db.query('DELETE FROM email_changes WHERE user_id = $1', [userId]);
}

/** Applies a pending change (single use). The new address counts as verified; every session is signed out. Returns false for a dead link. */
export async function confirmEmailChange(ctx: Ctx, rawToken: string): Promise<boolean> {
  const [p] = await ctx.db.query('DELETE FROM email_changes WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, new_email', [sha256(rawToken)]);
  if (!p) return false;
  const [before] = await ctx.db.query('SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL', [p.user_id]);
  if (!before) return false;
  try {
    await ctx.db.query('UPDATE users SET email = $2, verified = true WHERE id = $1', [p.user_id, p.new_email]);
  } catch (e: any) {
    if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) return false; // somebody registered the address in the meantime
    throw e;
  }
  await ctx.db.query(`DELETE FROM auth_tokens WHERE user_id = $1 AND kind IN ('verify_email','reset_password')`, [p.user_id]);
  const revoked = await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1 AND NOT revoked RETURNING id', [p.user_id]);
  await dropPushDevices(ctx, revoked.map((r) => r.id));
  revoked.forEach((r) => ctx.hub.disconnectAuthSession(r.id));
  if (before.email) {
    void ctx.mailer.send({
      to: before.email,
      ...actionEmail({
        subject: 'Your Jorcord email address was changed',
        heading: 'Your email was changed',
        paragraphs: [`The email address of your Jorcord account is now ${p.new_email}. All devices were signed out.`],
        action: { label: 'Not you? Reset your password', url: webUrl(ctx, '/forgot-password') },
        footnote: ['If you did not make this change, contact the server operator and secure your email account.'],
      }),
    }).catch((e) => ctx.log.warn({ err: e }, 'email changed notice failed'));
  }
  return true;
}

// ---------------------------------------------------------------- self-service disable (reversible)
/** Signs the account out everywhere and parks it; the next successful login reactivates it (see issueTokens). */
export async function disableOwnAccount(ctx: Ctx, userId: string, input: { password: string; totp?: string }) {
  limitOrThrow(ctx.rl, `self-disable:${userId}`, 5, 15 * 60_000, ctx.config.rateLimit);
  const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!u || u.bot) throw badRequest('Bots cannot be disabled here');
  await confirmIdentity(ctx, u, input.password, input.totp);
  await ctx.db.query('UPDATE users SET self_disabled_at = coalesce(self_disabled_at, now()) WHERE id = $1', [userId]);
  const revoked = await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1 AND NOT revoked RETURNING id', [userId]);
  await dropPushDevices(ctx, revoked.map((r) => r.id));
  await ctx.db.query('DELETE FROM push_devices WHERE user_id = $1', [userId]);
  ctx.hub.disconnectUser(userId);
  await ctx.hub.broadcastPresence(userId).catch(() => {});
}
