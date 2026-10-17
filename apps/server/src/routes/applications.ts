import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMS, DIRECTORY_CATEGORY_IDS, DIRECTORY_TAG_RE, OAuthScopes, PRIVILEGED_INTENTS, Perm, snowflake, type OAuthAuthorizePreview, type OAuthAuthorizeResult, type OAuthScope } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../errors';
import { generateAppKeys } from '../lib/interactionSig';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { assetUrl, idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { applicationDTO, getApplication, installApplication, newBotToken } from '../services/apps';
import { audit, buildGuildFull } from '../services/guilds';
import { pingInteractionsEndpoint } from '../services/interactions';
import { guildAccess, guildPerms, need } from '../services/perms';
import { userDTO } from '../services/serializers';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** https only (http is allowed for loopback development): an http redirect would leak the authorization code to the network. */
const redirectUri = z.string().max(512).refine((s) => { try { const u = new URL(s); return (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) && !u.username && !u.password && !u.hash; } catch { return false; } }, 'must be an absolute https URL (http only for localhost) without credentials or fragment');
const pkceChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'code_challenge must be a base64url SHA-256 (43 chars)');
const pkceVerifier = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, 'invalid code_verifier');
const appFields = {
  name: z.string().trim().min(1).max(32).regex(/^[^\u0000-\u001f\u007f]+$/), description: z.string().max(400), icon: assetUrl.nullable(),
  redirectUris: z.array(redirectUri).max(10), botPublic: z.boolean(), interactionsEndpointUrl: z.string().max(512).url().nullable(),
  /** Privileged gateway intents (GUILD_MEMBERS | GUILD_PRESENCES | MESSAGE_CONTENT) this bot may request at IDENTIFY. */
  privilegedIntents: z.number().int().min(0).refine((n) => (n & ~PRIVILEGED_INTENTS) === 0, 'only privileged intent bits may be set'),
  /** App Directory listing (public bots only). */
  directoryListed: z.boolean(), directoryCategory: z.enum(DIRECTORY_CATEGORY_IDS), directorySummary: z.string().trim().max(140),
  directoryTags: z.array(z.string().regex(DIRECTORY_TAG_RE, 'tags are 2-20 chars: a-z 0-9 -')).max(5), directoryPermissions: z.string().regex(/^\d{1,20}$/),
};
const MAX_APPS_PER_USER = 25;

export function applicationRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Owner-only access (user sessions). Anything else is a 404 so application ids are not an existence oracle. */
  async function ownedApp(req: { userId: string; isBot: boolean }, id: string) {
    const row = req.isBot ? null : await getApplication(ctx, id);
    if (!row || row.owner_id !== req.userId) throw notFound('Application');
    return row;
  }

  app.post('/applications', async (req, reply) => {
    const b = parse(z.object({ name: appFields.name, description: appFields.description.optional(), icon: appFields.icon.optional(), redirectUris: appFields.redirectUris.optional(), botPublic: appFields.botPublic.optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `app-create:${req.userId}`, 10, 3600_000, ctx.config.rateLimit);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM applications WHERE owner_id = $1', [req.userId]);
    if (c.n >= MAX_APPS_PER_USER) throw new ApiError(400, 'MAX_APPLICATIONS', `At most ${MAX_APPS_PER_USER} applications`);
    const id = snowflake(), botId = snowflake();
    const { token, hash } = newBotToken(botId);
    const secret = randomToken(32);
    const keys = generateAppKeys(ctx.config.jwtSecret);
    await ctx.db.tx(async (q) => {
      await q.query(`INSERT INTO users (id, username, display_name, avatar, bot, verified, presence) VALUES ($1,$2,$2,$3,true,true,'online')`, [botId, b.name, b.icon ?? null]);
      await q.query(
        `INSERT INTO applications (id, owner_id, name, description, icon, bot_user_id, bot_token_hash, client_secret_hash, public_key, private_key_enc, redirect_uris, bot_public)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
        [id, req.userId, b.name, b.description ?? '', b.icon ?? null, botId, hash, sha256(secret), keys.publicKey, keys.privateKeyEnc, JSON.stringify(b.redirectUris ?? []), b.botPublic ?? true]);
    });
    return reply.code(201).send(await applicationDTO(ctx, (await getApplication(ctx, id))!, { token, clientSecret: secret }));
  });

  app.get('/applications', async (req) => {
    const rows = await ctx.db.query('SELECT * FROM applications WHERE owner_id = $1 ORDER BY id', [req.userId]);
    return Promise.all(rows.map((r) => applicationDTO(ctx, r)));
  });
  /** The calling bot's own application. */
  app.get('/applications/@me', async (req) => {
    if (!req.isBot) throw new ApiError(403, 'USER_FORBIDDEN', 'Only bots can use this endpoint').num(20002);
    return applicationDTO(ctx, (await getApplication(ctx, req.applicationId!))!);
  });
  app.get('/applications/:id', async (req) => applicationDTO(ctx, await ownedApp(req, parse(z.object({ id: idSchema }), req.params).id)));

  app.patch('/applications/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object(appFields).partial().strict(), req.body);
    const row = await ownedApp(req, id);
    if (b.interactionsEndpointUrl) limitOrThrow(ctx.rl, `ix-endpoint-verify:${req.userId}`, 10, 60_000, ctx.config.rateLimit); // each attempt makes the server issue an outbound request
    if (b.interactionsEndpointUrl) await pingInteractionsEndpoint(ctx, row, b.interactionsEndpointUrl); // must answer a signed PING with {type:1}
    const sets: string[] = [], vals: unknown[] = [id];
    const col: Record<string, string> = { name: 'name', description: 'description', icon: 'icon', redirectUris: 'redirect_uris', botPublic: 'bot_public', interactionsEndpointUrl: 'interactions_endpoint_url', privilegedIntents: 'privileged_intents',
      directoryListed: 'directory_listed', directoryCategory: 'directory_category', directorySummary: 'directory_summary', directoryTags: 'directory_tags', directoryPermissions: 'directory_permissions' };
    // a private bot is never listed; listing needs a public bot with a real description and summary
    const bag = b as Record<string, any>;
    if (bag.botPublic === false) bag.directoryListed = false;
    const willList = bag.directoryListed ?? row.directory_listed;
    if (willList && bag.directoryListed === true) {
      if (!(bag.botPublic ?? row.bot_public)) throw badRequest('Only public bots can be listed in the App Directory');
      if (String(bag.description ?? row.description ?? '').trim().length < 10) throw badRequest('Write a description of at least 10 characters before listing');
      if (String(bag.directorySummary ?? row.directory_summary ?? '').trim().length < 10) throw badRequest('Write a summary of at least 10 characters before listing');
    }
    if (bag.directoryPermissions !== undefined) bag.directoryPermissions = (BigInt(bag.directoryPermissions) & ALL_PERMS).toString();
    if (bag.directoryTags) bag.directoryTags = [...new Set(bag.directoryTags as string[])];
    const jsonCols = new Set(['redirectUris', 'directoryTags']);
    for (const [k, v] of Object.entries(b)) { vals.push(jsonCols.has(k) ? JSON.stringify(v) : v); sets.push(`${col[k]} = $${vals.length}${jsonCols.has(k) ? '::jsonb' : ''}`); }
    if (bag.directoryListed === true && !row.directory_listed) sets.push('directory_listed_at = now()');
    const dropped = b.privilegedIntents !== undefined && (row.privileged_intents & ~b.privilegedIntents) !== 0;
    if (sets.length) await ctx.db.query(`UPDATE applications SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (dropped) ctx.hub.disconnectAuthSession(`bot:${id}`); // sessions that rely on a switched-off privileged intent must re-identify
    if (b.name !== undefined || b.icon !== undefined) await ctx.db.query('UPDATE users SET display_name = COALESCE($2, display_name), username = COALESCE($2, username), avatar = CASE WHEN $4 THEN $3 ELSE avatar END WHERE id = $1', [row.bot_user_id, b.name ?? null, b.icon ?? null, b.icon !== undefined]);
    return applicationDTO(ctx, (await getApplication(ctx, id))!);
  });

  app.delete('/applications/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const row = await ownedApp(req, id);
    const guilds = (await ctx.db.query('SELECT guild_id FROM members WHERE user_id = $1', [row.bot_user_id])).map((r) => r.guild_id as string);
    ctx.hub.disconnectUser(row.bot_user_id);
    await ctx.db.tx(async (q) => {
      await q.query(`DELETE FROM roles WHERE managed_app_id = $1`, [id]);
      await q.query('DELETE FROM applications WHERE id = $1', [id]);
      await q.query('DELETE FROM users WHERE id = $1', [row.bot_user_id]); // cascades members
    });
    await ctx.pcache.invalidate({ k: 'user', userId: row.bot_user_id });
    for (const g of guilds) { await ctx.pcache.invalidate({ k: 'guild', guildId: g }); await ctx.hub.toGuild(g, 'MEMBER_REMOVE', { guildId: g, userId: row.bot_user_id }); }
    return reply.code(204).send();
  });

  /** Regenerates the bot token (old token stops working immediately; live gateway sessions are dropped). The new token is returned once. */
  app.post('/applications/:id/bot/reset-token', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const row = await ownedApp(req, id);
    limitOrThrow(ctx.rl, `app-reset:${req.userId}`, 10, 3600_000, ctx.config.rateLimit);
    const { token, hash } = newBotToken(row.bot_user_id);
    await ctx.db.query('UPDATE applications SET bot_token_hash = $2 WHERE id = $1', [id, hash]);
    ctx.hub.disconnectAuthSession(`bot:${id}`);
    return { token };
  });
  app.post('/applications/:id/reset-secret', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await ownedApp(req, id);
    limitOrThrow(ctx.rl, `app-reset:${req.userId}`, 10, 3600_000, ctx.config.rateLimit);
    const secret = randomToken(32);
    await ctx.db.query('UPDATE applications SET client_secret_hash = $2 WHERE id = $1', [id, sha256(secret)]);
    await ctx.db.query('DELETE FROM oauth_tokens WHERE application_id = $1', [id]);
    return { clientSecret: secret };
  });
  app.get('/applications/:id/installs', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await ownedApp(req, id);
    return (await ctx.db.query('SELECT guild_id, scopes, created_at FROM application_installs WHERE application_id = $1 ORDER BY created_at', [id]))
      .map((r) => ({ guildId: r.guild_id, scopes: r.scopes, installedAt: new Date(r.created_at).toISOString() }));
  });

  // ---------- OAuth2 authorize (user session) ----------
  const scopeParam = z.union([z.string().max(200).transform((s) => s.split(/[\s,+]+/).filter(Boolean)), z.array(z.string().max(64)).max(10)]).transform((a) => [...new Set(a)]);
  function parseScopes(raw: string[]): OAuthScope[] {
    if (!raw.length) throw badRequest('At least one scope is required');
    const bad = raw.filter((s) => !(OAuthScopes as readonly string[]).includes(s));
    if (bad.length) throw new ApiError(400, 'INVALID_SCOPE', `Unknown scope: ${bad.join(', ')}`);
    return raw as OAuthScope[];
  }
  async function authorizableGuilds(userId: string) {
    const rows = await ctx.db.query('SELECT g.id, g.name, g.icon FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = $1 ORDER BY g.name', [userId]);
    const out = [];
    for (const g of rows) { try { need(guildPerms(await guildAccess(ctx, userId, g.id)), Perm.MANAGE_GUILD); out.push({ id: g.id as string, name: g.name as string, icon: g.icon ?? null }); } catch { /* not a manager */ } }
    return out;
  }
  const permsParam = z.string().regex(/^\d{1,20}$/).default('0');

  app.get('/oauth2/authorize', async (req): Promise<OAuthAuthorizePreview> => {
    const q = parse(z.object({ clientId: idSchema, scope: scopeParam, permissions: permsParam }), req.query);
    const scopes = parseScopes(q.scope);
    const row = await getApplication(ctx, q.clientId);
    if (!row || ((scopes.includes('bot') || scopes.includes('applications.commands')) && !row.bot_public && row.owner_id !== req.userId)) throw notFound('Application');
    const a = await applicationDTO(ctx, row);
    return { application: { id: a.id, name: a.name, description: a.description, icon: a.icon, botUser: a.botUser }, scopes, permissions: (BigInt(q.permissions) & ALL_PERMS).toString(), guilds: await authorizableGuilds(req.userId) };
  });

  app.post('/oauth2/authorize', async (req, reply): Promise<OAuthAuthorizeResult> => {
    const b = parse(z.object({ clientId: idSchema, scope: scopeParam, permissions: permsParam.optional(), guildId: idSchema.optional(), redirectUri: z.string().max(512).optional(), state: z.string().max(512).optional(), codeChallenge: pkceChallenge.optional(), codeChallengeMethod: z.literal('S256').optional() }).strict(), req.body);
    if (!!b.codeChallenge !== !!b.codeChallengeMethod) throw badRequest('codeChallenge and codeChallengeMethod (S256) go together');
    limitOrThrow(ctx.rl, `oauth-authz:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    const scopes = parseScopes(b.scope);
    const row = await getApplication(ctx, b.clientId);
    if (!row || ((scopes.includes('bot') || scopes.includes('applications.commands')) && !row.bot_public && row.owner_id !== req.userId)) throw notFound('Application');
    const out: OAuthAuthorizeResult = {};
    if (scopes.includes('bot') || scopes.includes('applications.commands')) {
      if (!b.guildId) throw badRequest('guildId is required for the bot and applications.commands scopes');
      const gp = await guildAccess(ctx, req.userId, b.guildId); // 404 for non-members
      const perms = guildPerms(gp);
      need(perms, Perm.MANAGE_GUILD);
      const asked = BigInt(b.permissions ?? '0') & ALL_PERMS;
      if ((asked & ~perms) !== 0n) throw forbidden('You cannot grant permissions you do not have', 'PERMISSION_ESCALATION'); // authorizer may only delegate what they hold
      const [ban] = scopes.includes('bot') ? await ctx.db.query('SELECT 1 AS x FROM bans WHERE guild_id = $1 AND user_id = $2', [b.guildId, row.bot_user_id]) : [];
      if (ban) throw forbidden('This bot is banned from the server', 'BANNED');
      if (scopes.includes('bot')) {
        const [c] = await ctx.db.query(`SELECT count(*)::int AS n FROM application_installs WHERE guild_id = $1 AND 'bot' IN (SELECT jsonb_array_elements_text(scopes))`, [b.guildId]);
        if (c.n >= 50) throw new ApiError(400, 'MAX_BOTS', 'This server has too many bots');
      }
      await installApplication(ctx, { app: row, guildId: b.guildId, scopes: scopes.filter((s) => s !== 'identify'), permissions: asked, installedBy: req.userId });
      out.guildId = b.guildId;
    }
    if (scopes.includes('identify')) {
      const uris: string[] = row.redirect_uris ?? [];
      if (!b.redirectUri || !uris.includes(b.redirectUri)) throw new ApiError(400, 'INVALID_REDIRECT_URI', 'redirectUri must exactly match a registered redirect URI');
      const code = randomToken(24);
      await ctx.db.query('INSERT INTO oauth_codes (code_hash, application_id, user_id, scopes, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6, now() + interval \'10 minutes\')', [sha256(code), row.id, req.userId, JSON.stringify(scopes), b.redirectUri, b.codeChallenge ?? null]);
      out.code = code; out.redirectUri = b.redirectUri; if (b.state) out.state = b.state;
    }
    void buildGuildFull; void audit;
    return reply.code(200).send(out);
  });
}

/** Client-authenticated OAuth2 endpoints (no user session). */
export function oauthPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  async function authClient(clientId: string, clientSecret: string) {
    const row = await getApplication(ctx, clientId);
    if (!row || !safeEqual(row.client_secret_hash, sha256(clientSecret))) throw unauthorized('Invalid client credentials', 'INVALID_CLIENT');
    return row;
  }
  app.post('/oauth2/token', async (req) => {
    const b = parse(z.object({ clientId: idSchema, clientSecret: z.string().min(1).max(200), grantType: z.literal('authorization_code'), code: z.string().min(1).max(200), redirectUri: z.string().max(512), codeVerifier: pkceVerifier.optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `oauth-token:${req.ip}`, 30, 60_000, ctx.config.rateLimit);
    const row = await authClient(b.clientId, b.clientSecret);
    const [c] = await ctx.db.query('UPDATE oauth_codes SET used = true WHERE code_hash = $1 AND application_id = $2 AND NOT used AND expires_at > now() RETURNING *', [sha256(b.code), row.id]); // atomic single use
    if (!c || c.redirect_uri !== b.redirectUri) throw new ApiError(400, 'INVALID_GRANT', 'Invalid, used or expired code');
    // PKCE: a code issued with a challenge is worthless without the matching verifier (the code is already burned above, so a wrong guess cannot be retried)
    if (c.code_challenge && (!b.codeVerifier || !safeEqual(c.code_challenge, createHash('sha256').update(b.codeVerifier).digest('base64url')))) throw new ApiError(400, 'INVALID_GRANT', 'code_verifier does not match the code_challenge');
    const token = `jco_${randomToken(32)}`;
    await ctx.db.query(`INSERT INTO oauth_tokens (token_hash, application_id, user_id, scopes, expires_at) VALUES ($1,$2,$3,$4::jsonb, now() + interval '7 days')`, [sha256(token), row.id, c.user_id, JSON.stringify(c.scopes)]);
    return { accessToken: token, tokenType: 'Bearer', expiresIn: 7 * 86400, scope: (c.scopes as string[]).join(' ') };
  });
  app.post('/oauth2/token/revoke', async (req, reply) => {
    const b = parse(z.object({ clientId: idSchema, clientSecret: z.string().min(1).max(200), token: z.string().min(1).max(200) }).strict(), req.body);
    limitOrThrow(ctx.rl, `oauth-token:${req.ip}`, 30, 60_000, ctx.config.rateLimit);
    const row = await authClient(b.clientId, b.clientSecret);
    await ctx.db.query('DELETE FROM oauth_tokens WHERE token_hash = $1 AND application_id = $2', [sha256(b.token), row.id]);
    return reply.code(200).send({});
  });
  /** Who authorised this token: application, scopes and (with `identify`) the user. */
  app.get('/oauth2/@me', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer jco_')) throw unauthorized('OAuth2 access token required', 'INVALID_TOKEN');
    limitOrThrow(ctx.rl, `oauth-me:${req.ip}`, 120, 60_000, ctx.config.rateLimit);
    const [t] = await ctx.db.query('SELECT * FROM oauth_tokens WHERE token_hash = $1 AND expires_at > now()', [sha256(h.slice(7))]);
    if (!t) throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    const [appRow] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [t.application_id]);
    const a = await applicationDTO(ctx, appRow);
    let user = null;
    if ((t.scopes as string[]).includes('identify')) { const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [t.user_id]); const d = userDTO(ctx, u); user = { id: d.id, username: d.username, displayName: d.displayName, avatar: d.avatar, bot: d.bot }; }
    return { application: { id: a.id, name: a.name, icon: a.icon }, scopes: t.scopes, expires: new Date(t.expires_at).toISOString(), user };
  });
}
