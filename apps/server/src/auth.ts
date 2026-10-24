import type { FastifyReply, FastifyRequest } from 'fastify';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from './ctx';
import { forbidden, unauthorized } from './errors';
import { randomToken, sha256, signAccess, verifyAccess } from './lib/crypto';
import { verifyBotToken } from './services/apps';
import { selfUserDTO } from './services/serializers';

declare module 'fastify' {
  interface FastifyRequest { userId: string; authSessionId: string; isBot: boolean; applicationId: string | null }
}

/** Endpoints that only make sense for human accounts (sessions, MFA, relationships, push, account deletion, app/OAuth management). */
const BOT_BLOCKED = /^(\w+ \/api\/v1\/(auth\/|users\/@me\/(relationships|push-devices|notification-settings|export|bans)|oauth2\/authorize|push\/)|DELETE \/api\/v1\/users\/@me\/?$|POST \/api\/v1\/(applications\/?$|interactions\/?$)|GET \/api\/v1\/applications\/?$|POST \/api\/v1\/(invites\/[^/]+|discover\/guilds\/[^/]+\/join|guilds\/?|guilds\/[^/]+\/(join|boosts))\/?$)/;
// ^ bots enter servers only through the OAuth2 install flow (consent + managed role + MANAGE_GUILD), never by invite/discovery join, and cannot create servers or boost

/** Verifies the bearer JWT and that its session is still live (so logout/revoke is immediate). */
export function authenticate(ctx: Ctx) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const h = req.headers.authorization;
    req.isBot = false; req.applicationId = null;
    if (h?.startsWith('Bot ')) {
      const bot = await verifyBotToken(ctx, h.slice(4).trim());
      if (!bot) throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
      if (BOT_BLOCKED.test(`${req.method} ${req.url.split('?')[0]}`)) throw forbidden('Bots cannot use this endpoint', 'BOT_FORBIDDEN').num(20001);
      req.userId = bot.userId; req.authSessionId = `bot:${bot.applicationId}`; req.isBot = true; req.applicationId = bot.applicationId;
      return;
    }
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    const claims = await verifyAccess(ctx.config.jwtSecret, h.slice(7));
    if (!claims) throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    const [s] = await ctx.db.query('SELECT 1 AS ok FROM sessions WHERE id = $1 AND user_id = $2 AND NOT revoked AND expires_at > now()', [claims.sessionId, claims.userId]);
    if (!s) throw unauthorized('Session expired', 'INVALID_TOKEN');
    req.userId = claims.userId; req.authSessionId = claims.sessionId;
  };
}

export async function verifyGatewayToken(ctx: Ctx, token: string): Promise<{ userId: string; sessionId: string } | null> {
  if (token.startsWith('Bot ')) {
    const bot = await verifyBotToken(ctx, token.slice(4).trim());
    return bot ? { userId: bot.userId, sessionId: `bot:${bot.applicationId}` } : null;
  }
  const claims = await verifyAccess(ctx.config.jwtSecret, token);
  if (!claims) return null;
  const [s] = await ctx.db.query('SELECT 1 AS ok FROM sessions WHERE id = $1 AND user_id = $2 AND NOT revoked AND expires_at > now()', [claims.sessionId, claims.userId]);
  return s ? claims : null;
}

export async function issueTokens(ctx: Ctx, userRow: any, req: FastifyRequest, existingSessionId?: string) {
  // every login/register/refresh/MFA path ends here, so a disabled account can never get new tokens
  if (userRow.disabled_at) throw forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
  // REQUIRE_EMAIL_VERIFICATION: no new session (password, passkey or QR login) until the mailbox is proven; refreshes of existing sessions are unaffected
  if (!existingSessionId && ctx.config.requireEmailVerification && !userRow.verified && !userRow.bot && userRow.email) throw forbidden('Verify your email address to sign in. Check your inbox or request a new link.', 'EMAIL_NOT_VERIFIED');
  const sid = existingSessionId ?? snowflake();
  const refresh = `${sid}.${randomToken(32)}`;
  const exp = new Date(Date.now() + ctx.config.refreshTtlSec * 1000);
  if (existingSessionId) {
    await ctx.db.query('UPDATE sessions SET refresh_hash = $2, last_used_at = now(), expires_at = $3 WHERE id = $1', [sid, sha256(refresh), exp]);
  } else {
    await ctx.db.query('INSERT INTO sessions (id, user_id, refresh_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [sid, userRow.id, sha256(refresh), String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip, exp]);
  }
  // logging in during the deletion grace period cancels the deletion (a refresh keeps its session, which deletion already revoked)
  let deletionCancelled = false;
  if (!existingSessionId && userRow.deletion_due_at) {
    await ctx.db.query('UPDATE users SET deletion_due_at = NULL WHERE id = $1 AND deleted_at IS NULL', [userRow.id]);
    userRow.deletion_due_at = null; deletionCancelled = true;
  }
  return { ...(deletionCancelled ? { deletionCancelled } : {}), user: selfUserDTO(ctx, userRow), accessToken: await signAccess(ctx.config.jwtSecret, userRow.id, sid, ctx.config.accessTtlSec), refreshToken: refresh };
}
