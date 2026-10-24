import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, conflict, notFound, unauthorized } from '../errors';
import { issueTokens } from '../auth';
import { decryptSecret, dummyVerify, encryptSecret, hashPassword, safeEqual, sha256, verifyPassword } from '../lib/crypto';
import { verifyTotp } from '../lib/totp';
import { dropPushDevices } from '../services/pushDevices';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { burnAuthToken, consumeAuthToken, peekAuthToken, sendPasswordChangedEmail, sendPasswordResetEmail, sendVerificationEmail } from '../services/authTokens';
import { mfaTicketFor } from './passkeys';
import { isReservedForOther } from '../services/accountChanges';
import { selfUserDTO } from '../services/serializers';


const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{2,32}$/, 'username must be 2-32 chars: a-z 0-9 _ .');
const passwordSchema = z.string().min(8).max(128);
const registerSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), username: usernameSchema, password: passwordSchema, displayName: z.string().trim().min(1).max(32).optional() }).strict();
const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict();

export function publicAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/auth/register', async (req, reply) => {
    limitOrThrow(ctx.rl, `register:${req.ip}`, 10, 3600_000, ctx.config.rateLimit); // mass sign-up / enumeration brake
    const b = parse(registerSchema, req.body);
    const id = snowflake();
    if (await isReservedForOther(ctx, b.username, null)) throw new ApiError(400, 'REGISTRATION_FAILED', 'Could not register with these details'); // a handle someone just gave up is held for them for 14 days
    try {
      await ctx.db.query('INSERT INTO users (id, email, username, display_name, password_hash) VALUES ($1,$2,$3,$4,$5)',
        [id, b.email, b.username, b.displayName ?? null, await hashPassword(b.password)]);
    } catch (e: any) {
      if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw new ApiError(400, 'REGISTRATION_FAILED', 'Could not register with these details'); // identical for a taken email and a taken username: no account enumeration
      throw e;
    }
    const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [id]);
    await sendVerificationEmail(ctx, row).catch((e) => ctx.log.warn({ err: e }, 'verification email failed')); // never block sign-up on mail
    if (ctx.config.requireEmailVerification) return reply.code(201).send({ verificationRequired: true, email: row.email }); // no session until the mailbox is proven
    return reply.code(201).send(await issueTokens(ctx, row, req));
  });

  /** Always 204 (no enumeration); only an existing, unverified, non-bot account actually gets mail. */
  app.post('/auth/verify-email/resend', async (req, reply) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict(), req.body);
    limitOrThrow(ctx.rl, `verify-resend:ip:${req.ip}`, 10, 15 * 60_000, ctx.config.rateLimit);
    if (ctx.config.rateLimit && ctx.rl.hit(`verify-resend:email:${email}`, 3, 3600_000)) return reply.code(204).send(); // silently capped per address
    const [row] = await ctx.db.query('SELECT id, email FROM users WHERE lower(email) = $1 AND NOT bot AND NOT verified AND deleted_at IS NULL', [email]);
    if (row) void sendVerificationEmail(ctx, row).catch((e) => ctx.log.warn({ err: e }, 'verification email failed'));
    return reply.code(204).send();
  });

  app.post('/auth/login', async (req) => {
    const b = parse(loginSchema, req.body);
    const throttleKey = `login:${b.email}`, ipKey = `login-ip:${req.ip}`;
    if (ctx.config.rateLimit && (ctx.rl.isLimited(throttleKey, 8) || ctx.rl.isLimited(ipKey, 40))) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed attempts, try again later');
    const fail = () => { ctx.rl.hit(throttleKey, 8, 15 * 60_000); ctx.rl.hit(ipKey, 40, 15 * 60_000); return unauthorized('Invalid credentials', 'INVALID_CREDENTIALS'); };
    const [row] = await ctx.db.query('SELECT * FROM users WHERE lower(email) = $1 AND NOT bot', [b.email]);
    if (!row?.password_hash) { await dummyVerify(b.password); throw fail(); }
    if (!(await verifyPassword(row.password_hash, b.password))) throw fail();
    if (row.mfa_enabled) {
      if (!b.totp) {
        const ticket = await mfaTicketFor(ctx, row.id); // password was right: a passkey may stand in for the TOTP code
        throw unauthorized('Two-factor code required', 'MFA_REQUIRED').with(ticket ? { methods: ['totp', 'passkey'], mfaTicket: ticket } : { methods: ['totp'] });
      }
      if (!(await verifyTotp(ctx, row, b.totp))) throw fail();
    }
    return issueTokens(ctx, row, req);
  });

  // ---- email verification (the token in the emailed link is the credential) ----
  app.post('/auth/verify-email', async (req, reply) => {
    limitOrThrow(ctx.rl, `verify:${req.ip}`, 20, 15 * 60_000, ctx.config.rateLimit);
    const { token } = parse(z.object({ token: z.string().min(20).max(128) }).strict(), req.body);
    const userId = await consumeAuthToken(ctx, token, 'verify_email');
    if (!userId) throw new ApiError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    const [row] = await ctx.db.query('UPDATE users SET verified = true WHERE id = $1 AND deleted_at IS NULL RETURNING *', [userId]);
    if (row) await ctx.hub.toUser(userId, 'USER_UPDATE', selfUserDTO(ctx, row) as any);
    return reply.code(204).send();
  });

  // ---- password reset ----
  /** Always 204, whether or not the address has an account (no user enumeration). */
  app.post('/auth/password/forgot', async (req, reply) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict(), req.body);
    limitOrThrow(ctx.rl, `forgot:ip:${req.ip}`, 10, 15 * 60_000, ctx.config.rateLimit);
    if (ctx.config.rateLimit && ctx.rl.hit(`forgot:email:${email}`, 3, 3600_000)) return reply.code(204).send(); // silently capped per address
    const [row] = await ctx.db.query('SELECT id, email FROM users WHERE lower(email) = $1 AND NOT bot AND password_hash IS NOT NULL AND deleted_at IS NULL', [email]);
    // fire-and-forget so response time does not reveal whether the address has an account (SMTP is slow)
    if (row) void sendPasswordResetEmail(ctx, row).catch((e) => ctx.log.warn({ err: e }, 'reset email failed'));
    return reply.code(204).send();
  });
  /** Lets the reset page reject a dead link before the user types a new password. Never reveals the account. */
  app.post('/auth/password/reset/validate', async (req, reply) => {
    limitOrThrow(ctx.rl, `reset-check:${req.ip}`, 30, 15 * 60_000, ctx.config.rateLimit);
    const { token } = parse(z.object({ token: z.string().min(20).max(128) }).strict(), req.body);
    const userId = await peekAuthToken(ctx, token, 'reset_password');
    if (!userId) return reply.send({ valid: false, mfaRequired: false });
    const [u] = await ctx.db.query('SELECT mfa_enabled FROM users WHERE id = $1', [userId]);
    return reply.send({ valid: true, mfaRequired: !!u?.mfa_enabled }); // the token holder already controls the mailbox; only the need for a code is disclosed
  });
  app.post('/auth/password/reset', async (req, reply) => {
    limitOrThrow(ctx.rl, `reset:${req.ip}`, 20, 15 * 60_000, ctx.config.rateLimit);
    const b = parse(z.object({ token: z.string().min(20).max(128), newPassword: passwordSchema, mfaCode: z.string().trim().regex(/^\d{6}$/, 'mfaCode must be 6 digits').optional() }).strict(), req.body);
    // A mailbox alone must not defeat two-factor: an account with 2FA also needs a valid TOTP code. A wrong code does not consume the token,
    // but 5 wrong guesses per token burn it (the 6-digit space cannot be walked), whatever IP they come from.
    const peeked = await peekAuthToken(ctx, b.token, 'reset_password');
    if (!peeked) throw new ApiError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    const [owner] = await ctx.db.query('SELECT id, mfa_enabled, mfa_secret FROM users WHERE id = $1 AND deleted_at IS NULL', [peeked]);
    if (owner?.mfa_enabled) {
      if (!b.mfaCode) throw new ApiError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app to reset this password');
      const tkey = `reset-mfa:${sha256(b.token)}`;
      if (!(await verifyTotp(ctx, owner, b.mfaCode))) {
        if (ctx.rl.hit(tkey, 4, 3600_000)) { // 5th wrong code: the token is dead
          await burnAuthToken(ctx, b.token, 'reset_password');
          throw new ApiError(400, 'INVALID_TOKEN', 'Too many wrong codes. Request a new reset link');
        }
        throw new ApiError(400, 'INVALID_CODE', 'Invalid authentication code');
      }
    }
    const userId = await consumeAuthToken(ctx, b.token, 'reset_password');
    if (!userId) throw new ApiError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    const [account] = await ctx.db.query('UPDATE users SET password_hash = $2, verified = true WHERE id = $1 AND deleted_at IS NULL RETURNING id, email', [userId, await hashPassword(b.newPassword)]);
    const revoked = await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1 AND NOT revoked RETURNING id', [userId]); // a reset logs out every device
    await dropPushDevices(ctx, revoked.map((r) => r.id));
    revoked.forEach((r) => ctx.hub.disconnectAuthSession(r.id));
    await ctx.db.query(`DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'reset_password'`, [userId]);
    if (account?.email) void sendPasswordChangedEmail(ctx, account).catch((e) => ctx.log.warn({ err: e }, 'password changed email failed'));
    return reply.code(204).send();
  });

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10).max(200) }).strict(), req.body);
    const sid = refreshToken.split('.')[0] ?? '';
    if (!idSchema.safeParse(sid).success) throw unauthorized('Invalid refresh token', 'INVALID_TOKEN');
    const [s] = await ctx.db.query('SELECT * FROM sessions WHERE id = $1', [sid]);
    if (!s || s.revoked || new Date(s.expires_at).getTime() < Date.now()) throw unauthorized('Invalid refresh token', 'INVALID_TOKEN');
    if (!safeEqual(s.refresh_hash, sha256(refreshToken))) {
      // a rotated-out token was replayed: assume theft and kill the session
      await ctx.db.query('UPDATE sessions SET revoked = true WHERE id = $1', [sid]);
      ctx.hub.disconnectAuthSession(sid);
      throw unauthorized('Refresh token reuse detected', 'TOKEN_REUSED');
    }
    const [user] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [s.user_id]);
    if (!user || user.deleted_at) throw unauthorized();
    return issueTokens(ctx, user, req, sid);
  });
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/auth/logout', async (req, reply) => {
    await ctx.db.query('UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2', [req.authSessionId, req.userId]);
    await dropPushDevices(ctx, [req.authSessionId]);
    ctx.hub.disconnectAuthSession(req.authSessionId);
    return reply.code(204).send();
  });

  app.post('/auth/verify-email/send', async (req, reply) => {
    limitOrThrow(ctx.rl, `verify-send:${req.userId}`, 3, 3600_000, ctx.config.rateLimit);
    const [u] = await ctx.db.query('SELECT id, email, verified FROM users WHERE id = $1', [req.userId]);
    if (u.verified) throw conflict('Email already verified', 'ALREADY_VERIFIED');
    await sendVerificationEmail(ctx, u);
    return reply.code(204).send();
  });

  app.get('/auth/sessions', async (req) => {
    const rows = await ctx.db.query('SELECT * FROM sessions WHERE user_id = $1 AND NOT revoked AND expires_at > now() ORDER BY last_used_at DESC', [req.userId]);
    return rows.map((s) => ({ id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: iso(s.created_at), lastUsedAt: iso(s.last_used_at), current: s.id === req.authSessionId }));
  });
  app.post('/auth/sessions', async (req, reply) => {
    const b = parse(z.object({ sessionId: idSchema.optional(), all: z.boolean().optional() }).strict(), req.body);
    if (b.all) {
      const rows = await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1 AND id <> $2 AND NOT revoked RETURNING id', [req.userId, req.authSessionId]);
      await dropPushDevices(ctx, rows.map((r) => r.id));
      rows.forEach((r) => ctx.hub.disconnectAuthSession(r.id));
      return reply.code(204).send();
    }
    if (!b.sessionId) throw new ApiError(400, 'VALIDATION_ERROR', 'sessionId or all required');
    const rows = await ctx.db.query('UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2 RETURNING id', [b.sessionId, req.userId]); // user_id check = IDOR guard
    if (!rows.length) throw notFound('Session');
    await dropPushDevices(ctx, [b.sessionId]);
    ctx.hub.disconnectAuthSession(b.sessionId);
    return reply.code(204).send();
  });

  app.post('/auth/mfa/setup', async (req) => {
    limitOrThrow(ctx.rl, `mfa-setup:${req.userId}`, 10, 15 * 60_000, ctx.config.rateLimit);
    const [u] = await ctx.db.query('SELECT email, mfa_enabled FROM users WHERE id = $1', [req.userId]);
    if (u.mfa_enabled) throw conflict('MFA already enabled', 'MFA_ALREADY_ENABLED');
    const secret = authenticator.generateSecret();
    await ctx.db.query('UPDATE users SET mfa_secret = $2 WHERE id = $1', [req.userId, encryptSecret(secret, ctx.config.jwtSecret)]);
    return { secret, otpauthUrl: authenticator.keyuri(u.email, 'Jorcord', secret) };
  });
  app.post('/auth/mfa/enable', async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    limitOrThrow(ctx.rl, `mfa-enable:${req.userId}`, 10, 15 * 60_000, ctx.config.rateLimit); // 6-digit code: brute-force brake
    const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!u.mfa_secret) throw new ApiError(400, 'MFA_NOT_SETUP', 'Call /auth/mfa/setup first');
    if (!authenticator.check(code, decryptSecret(u.mfa_secret, ctx.config.jwtSecret))) throw new ApiError(400, 'INVALID_CODE', 'Invalid code');
    const [row] = await ctx.db.query('UPDATE users SET mfa_enabled = true WHERE id = $1 RETURNING *', [req.userId]);
    return selfUserDTO(ctx, row);
  });
  app.post('/auth/mfa/disable', async (req) => {
    const b = parse(z.object({ password: z.string().max(128), code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    limitOrThrow(ctx.rl, `mfa-disable:${req.userId}`, 10, 15 * 60_000, ctx.config.rateLimit);
    const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!u.mfa_enabled) throw new ApiError(400, 'MFA_NOT_ENABLED', 'MFA is not enabled');
    if (!(await verifyPassword(u.password_hash, b.password))) throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    if (!(await verifyTotp(ctx, u, b.code))) throw new ApiError(400, 'INVALID_CODE', 'Invalid code');
    const [row] = await ctx.db.query('UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1 RETURNING *', [req.userId]);
    return selfUserDTO(ctx, row);
  });

  app.post('/auth/password', async (req, reply) => {
    const b = parse(z.object({ currentPassword: z.string().max(128), newPassword: passwordSchema }).strict(), req.body);
    limitOrThrow(ctx.rl, `pwchange:${req.userId}`, 10, 15 * 60_000, ctx.config.rateLimit); // current-password guessing brake
    const [u] = await ctx.db.query('SELECT password_hash, email FROM users WHERE id = $1', [req.userId]);
    if (!(await verifyPassword(u.password_hash, b.currentPassword))) throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    await ctx.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.userId, await hashPassword(b.newPassword)]);
    const others = await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1 AND id <> $2 AND NOT revoked RETURNING id', [req.userId, req.authSessionId]);
    await dropPushDevices(ctx, others.map((r) => r.id));
    others.forEach((r) => ctx.hub.disconnectAuthSession(r.id));
    if (u.email) void sendPasswordChangedEmail(ctx, { id: req.userId, email: u.email }).catch((e) => ctx.log.warn({ err: e }, 'password changed email failed'));
    return reply.code(204).send();
  });
}
