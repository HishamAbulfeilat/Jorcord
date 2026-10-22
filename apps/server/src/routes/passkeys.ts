import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { z } from 'zod';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, notFound, unauthorized } from '../errors';
import { issueTokens } from '../auth';
import { randomToken, verifyPassword } from '../lib/crypto';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { verifyTotp } from '../lib/totp';
import { actionEmail } from '../services/emailTemplates';
import { bad, challengeFromResponse, consumeChallenge, passkeyDTO, rpOf, storeChallenge, ticketTtlMs } from '../services/passkeys';

const MAX_PASSKEYS = 10;
const nameSchema = z.string().trim().min(1).max(64);
/** Loose shape check; @simplewebauthn validates the contents. */
const credentialJson = z.object({ id: z.string().min(1).max(1400), rawId: z.string().max(1400), type: z.literal('public-key'), response: z.record(z.unknown()) }).passthrough();
const bytes = (b64u: string) => new Uint8Array(Buffer.from(b64u, 'base64url'));

async function notifyPasskeyChange(ctx: Ctx, userId: string, what: 'added' | 'removed', name: string) {
  const [u] = await ctx.db.query('SELECT email FROM users WHERE id = $1', [userId]);
  if (!u?.email) return;
  const m = actionEmail({
    subject: `A passkey was ${what} on your Jorcord account`, heading: `Passkey ${what}`,
    paragraphs: [`The passkey "${name}" was ${what} ${what === 'added' ? 'to' : 'from'} your account.`, 'If this was not you, change your password immediately and sign out your other devices from Settings > Security.'],
  });
  await ctx.mailer.send({ to: u.email, ...m });
}

/** Re-authentication for sensitive passkey changes: the bearer token alone is not enough to add a persistent credential. */
async function reauth(ctx: Ctx, userId: string, password: string, totp?: string) {
  limitOrThrow(ctx.rl, `passkey-reauth:${userId}`, 10, 15 * 60_000, ctx.config.rateLimit);
  const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u?.password_hash || !(await verifyPassword(u.password_hash, password))) throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  if (u.mfa_enabled && (!totp || !(await verifyTotp(ctx, u, totp)))) throw new ApiError(401, 'MFA_REQUIRED', 'A valid two-factor code is required');
  return u;
}

/** Verifies an assertion against the stored credential (counter check included) and bumps counter/last_used. Returns the passkey row. */
async function verifyAssertion(ctx: Ctx, response: any, purpose: 'login' | 'mfa', check: (c: { user_id: string | null; ref: string | null }, pk: any) => boolean) {
  const challenge = challengeFromResponse(response);
  const [pk] = await ctx.db.query('SELECT * FROM user_passkeys WHERE credential_id = $1', [String(response.id)]);
  const stored = challenge ? await consumeChallenge(ctx, challenge, purpose) : null; // consumed before verifying: a replay or retry needs a fresh challenge
  if (!challenge || !stored || !pk || !check(stored, pk)) throw bad();
  const rp = rpOf(ctx);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: bytes(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
    });
  } catch (e: any) {
    // includes cloned-authenticator detection (counter did not advance)
    ctx.log.warn({ userId: pk.user_id, passkeyId: pk.id, reason: String(e?.message).slice(0, 120) }, 'passkey assertion rejected');
    throw bad();
  }
  if (!verification.verified) throw bad();
  // optimistic counter update: two parallel assertions with the same counter cannot both win
  const upd = await ctx.db.query('UPDATE user_passkeys SET counter = $2, last_used_at = now(), backed_up = $3 WHERE id = $1 AND counter = $4 RETURNING id',
    [pk.id, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp, pk.counter]);
  if (!upd.length) throw bad();
  return pk;
}

export function passkeyPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  const failKey = (req: { ip: string }) => `passkey-fail:${req.ip}`;
  const guard = (req: { ip: string }) => {
    if (ctx.config.rateLimit && ctx.rl.isLimited(failKey(req), 15)) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed attempts, try again later');
  };
  const failed = (req: { ip: string }) => { ctx.rl.hit(failKey(req), 15, 15 * 60_000); };

  // ---- passwordless sign-in (discoverable credential, user verification required = possession + biometric/PIN) ----
  app.post('/auth/passkey/login/options', async (req) => {
    limitOrThrow(ctx.rl, `passkey-opts:${req.ip}`, 30, 15 * 60_000, ctx.config.rateLimit);
    const o = await generateAuthenticationOptions({ rpID: rpOf(ctx).rpID, userVerification: 'required' });
    await storeChallenge(ctx, o.challenge, 'login', null);
    return o;
  });
  app.post('/auth/passkey/login/verify', async (req) => {
    guard(req);
    const { response } = parse(z.object({ response: credentialJson }).strict(), req.body);
    let pk;
    try { pk = await verifyAssertion(ctx, response, 'login', () => true); } catch (e) { failed(req); throw e; }
    const [user] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [pk.user_id]);
    if (!user || user.deleted_at || user.bot) { failed(req); throw bad(); }
    return issueTokens(ctx, user, req); // same session/token machinery as password login; disabled accounts are refused there
  });

  // ---- second factor: after a correct password on an MFA account, a passkey may replace the TOTP code ----
  app.post('/auth/passkey/mfa/options', async (req) => {
    limitOrThrow(ctx.rl, `passkey-opts:${req.ip}`, 30, 15 * 60_000, ctx.config.rateLimit);
    const { ticket } = parse(z.object({ ticket: z.string().min(20).max(128) }).strict(), req.body);
    const [t] = await ctx.db.query(`SELECT user_id FROM webauthn_challenges WHERE challenge = $1 AND purpose = 'mfa_ticket' AND expires_at > now()`, [ticket]);
    if (!t) throw bad('This sign-in attempt expired, enter your password again');
    const creds = await ctx.db.query('SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1', [t.user_id]);
    const o = await generateAuthenticationOptions({ rpID: rpOf(ctx).rpID, userVerification: 'required', allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports })) });
    await storeChallenge(ctx, o.challenge, 'mfa', t.user_id, ticket);
    return o;
  });
  app.post('/auth/passkey/mfa/verify', async (req) => {
    guard(req);
    const b = parse(z.object({ ticket: z.string().min(20).max(128), response: credentialJson }).strict(), req.body);
    let pk;
    try {
      pk = await verifyAssertion(ctx, b.response, 'mfa', (c, k) => c.user_id === k.user_id && c.ref === b.ticket);
      if (!(await consumeChallenge(ctx, b.ticket, 'mfa_ticket'))) throw bad(); // the password step is single-use too
    } catch (e) { failed(req); throw e; }
    const [user] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [pk.user_id]);
    if (!user || user.deleted_at) throw bad();
    return issueTokens(ctx, user, req);
  });
}

/** Called by password login when the account has MFA on and at least one passkey: hands back a short-lived single-use ticket. */
export async function mfaTicketFor(ctx: Ctx, userId: string): Promise<string | null> {
  const [{ n }] = await ctx.db.query('SELECT count(*)::int AS n FROM user_passkeys WHERE user_id = $1', [userId]);
  if (!n) return null;
  const ticket = randomToken(32);
  await storeChallenge(ctx, ticket, 'mfa_ticket', userId, null, ticketTtlMs);
  return ticket;
}

export function passkeyRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/auth/passkeys', async (req) => {
    const rows = await ctx.db.query('SELECT * FROM user_passkeys WHERE user_id = $1 ORDER BY created_at', [req.userId]);
    return rows.map(passkeyDTO); // never exposes credential ids, keys or counters
  });

  app.post('/auth/passkeys/register/options', async (req) => {
    const b = parse(z.object({ password: z.string().max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `passkey-reg:${req.userId}`, 10, 15 * 60_000, ctx.config.rateLimit);
    const u = await reauth(ctx, req.userId, b.password, b.totp);
    const existing = await ctx.db.query('SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1', [req.userId]);
    if (existing.length >= MAX_PASSKEYS) throw new ApiError(409, 'PASSKEY_LIMIT', `You can register at most ${MAX_PASSKEYS} passkeys`);
    const rp = rpOf(ctx);
    const o = await generateRegistrationOptions({
      rpName: rp.rpName, rpID: rp.rpID, userName: u.email ?? u.username, userDisplayName: u.display_name ?? u.username, userID: Buffer.from(u.id, 'utf8'),
      attestationType: 'none', excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await storeChallenge(ctx, o.challenge, 'register', req.userId);
    return o;
  });
  app.post('/auth/passkeys/register/verify', async (req, reply) => {
    const b = parse(z.object({ name: nameSchema.optional(), response: credentialJson }).strict(), req.body);
    limitOrThrow(ctx.rl, `passkey-reg-verify:${req.userId}`, 20, 15 * 60_000, ctx.config.rateLimit);
    const challenge = challengeFromResponse(b.response);
    const stored = challenge ? await consumeChallenge(ctx, challenge, 'register') : null;
    if (!challenge || !stored || stored.user_id !== req.userId) throw bad(); // another user's challenge cannot be replayed here
    const rp = rpOf(ctx);
    let v;
    try { v = await verifyRegistrationResponse({ response: b.response as any, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true }); }
    catch (e: any) { ctx.log.warn({ userId: req.userId, reason: String(e?.message).slice(0, 120) }, 'passkey registration rejected'); throw bad(); }
    if (!v.verified || !v.registrationInfo) throw bad();
    const c = v.registrationInfo.credential;
    const [{ n }] = await ctx.db.query('SELECT count(*)::int AS n FROM user_passkeys WHERE user_id = $1', [req.userId]);
    if (n >= MAX_PASSKEYS) throw new ApiError(409, 'PASSKEY_LIMIT', `You can register at most ${MAX_PASSKEYS} passkeys`);
    const name = b.name ?? `Passkey ${n + 1}`;
    try {
      const [row] = await ctx.db.query(
        'INSERT INTO user_passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, name) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *',
        [snowflake(), req.userId, c.id, Buffer.from(c.publicKey).toString('base64url'), c.counter, JSON.stringify(c.transports ?? []), v.registrationInfo.credentialDeviceType, v.registrationInfo.credentialBackedUp, name]);
      ctx.log.info({ userId: req.userId, passkeyId: row.id }, 'passkey registered');
      void notifyPasskeyChange(ctx, req.userId, 'added', name).catch((e) => ctx.log.warn({ err: e }, 'passkey email failed'));
      return reply.code(201).send(passkeyDTO(row));
    } catch (e: any) {
      if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw new ApiError(409, 'PASSKEY_EXISTS', 'This passkey is already registered');
      throw e;
    }
  });

  app.patch('/auth/passkeys/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const { name } = parse(z.object({ name: nameSchema }).strict(), req.body);
    limitOrThrow(ctx.rl, `passkey-edit:${req.userId}`, 30, 15 * 60_000, ctx.config.rateLimit);
    const rows = await ctx.db.query('UPDATE user_passkeys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING *', [id, req.userId, name]); // user_id = IDOR guard
    if (!rows.length) throw notFound('Passkey');
    return passkeyDTO(rows[0]);
  });

  app.delete('/auth/passkeys/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ password: z.string().max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict(), req.body);
    await reauth(ctx, req.userId, b.password, b.totp);
    const rows = await ctx.db.query('DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2 RETURNING name', [id, req.userId]);
    if (!rows.length) throw notFound('Passkey');
    ctx.log.info({ userId: req.userId, passkeyId: id }, 'passkey removed');
    void notifyPasskeyChange(ctx, req.userId, 'removed', rows[0].name).catch((e) => ctx.log.warn({ err: e }, 'passkey email failed'));
    return reply.code(204).send();
  });
}
