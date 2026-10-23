import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_CONNECTIONS, connectionProvider, snowflake, type OAuthConnectionProvider } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { http, ProviderError } from '../lib/providerHttp';
import { refreshUserEverywhere } from './linkedroles';

export const STATE_TTL_SEC = 600;
const MAX_PENDING_PER_USER = 5;
export const BINDING_COOKIE = 'jc_oauth';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');
export const redirectUri = (ctx: Ctx, provider: OAuthConnectionProvider) => `${ctx.config.publicUrl.replace(/\/+$/, '')}/api/v1/connections/oauth/${provider}/callback`;

interface Creds { clientId: string; clientSecret: string }
/** Credentials for a provider, or null when the operator has not configured them (the feature is then off). */
export function credsFor(ctx: Ctx, provider: OAuthConnectionProvider): Creds | null {
  return provider === 'twitch' ? ctx.config.integrations.twitch : ctx.config.integrations.google;
}
export const oauthEnabled = (ctx: Ctx, provider: string) => (provider === 'twitch' || provider === 'youtube') && !!credsFor(ctx, provider);

export const disabled = (provider: string) => new ApiError(501, 'FEATURE_DISABLED', `Connecting ${provider === 'twitch' ? 'Twitch' : 'YouTube'} is not enabled on this server`);

/** Remote account as read from the provider: stable id, the handle to show, and the profile URL. */
export interface RemoteAccount { id: string; handle: string; url: string }

/** Creates the authorize URL. Returns the browser-binding nonce too: the route puts it into an HttpOnly cookie. */
export async function startAuthorize(ctx: Ctx, userId: string, provider: OAuthConnectionProvider): Promise<{ url: string; nonce: string }> {
  const creds = credsFor(ctx, provider); if (!creds) throw disabled(provider);
  await ctx.db.query('DELETE FROM connection_oauth_states WHERE expires_at < now()');
  // keep only the newest few pending requests of a user so this cannot be used to grow the table
  await ctx.db.query(`DELETE FROM connection_oauth_states WHERE user_id = $1 AND state_hash NOT IN (SELECT state_hash FROM connection_oauth_states WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`, [userId, MAX_PENDING_PER_USER - 1]);
  const state = b64url(randomBytes(32)), nonce = b64url(randomBytes(24));
  const verifier = provider === 'youtube' ? b64url(randomBytes(48)) : null; // Google supports PKCE, Twitch does not
  await ctx.db.query('INSERT INTO connection_oauth_states (state_hash, user_id, provider, code_verifier, binding_hash, expires_at) VALUES ($1,$2,$3,$4,$5, now() + $6 * interval \'1 second\')',
    [sha(state), userId, provider, verifier, sha(nonce), STATE_TTL_SEC]);
  const u = new URL(provider === 'twitch' ? 'https://id.twitch.tv/oauth2/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', creds.clientId); u.searchParams.set('redirect_uri', redirectUri(ctx, provider)); u.searchParams.set('response_type', 'code'); u.searchParams.set('state', state);
  if (provider === 'twitch') u.searchParams.set('scope', ''); // identity only: no scopes
  else {
    u.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.readonly'); u.searchParams.set('access_type', 'online'); u.searchParams.set('prompt', 'select_account');
    u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier!).digest())); u.searchParams.set('code_challenge_method', 'S256');
  }
  return { url: u.href, nonce };
}

/** Why a callback failed; the web client turns these into a message. */
export type OAuthFailure = 'denied' | 'invalid_state' | 'exchange_failed' | 'account_failed' | 'no_channel' | 'already_linked' | 'limit_reached' | 'disabled';
export class OAuthFlowError extends Error { constructor(public reason: OAuthFailure) { super(reason); } }

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function readTwitch(ctx: Ctx, creds: Creds, code: string): Promise<{ account: RemoteAccount; token: string }> {
  const tok = await http.json('https://id.twitch.tv/oauth2/token', { form: { client_id: creds.clientId, client_secret: creds.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri(ctx, 'twitch') } });
  const token = tok.status === 200 && typeof tok.body?.access_token === 'string' ? tok.body.access_token : null;
  if (!token) throw new OAuthFlowError('exchange_failed');
  const me = await http.json('https://api.twitch.tv/helix/users', { headers: { ...bearer(token), 'client-id': creds.clientId } });
  const u = me.status === 200 ? me.body?.data?.[0] : null;
  if (!u || typeof u.id !== 'string' || typeof u.login !== 'string' || !/^[A-Za-z0-9_]{1,25}$/.test(u.login)) throw new OAuthFlowError('account_failed');
  const login = u.login.toLowerCase();
  return { token, account: { id: u.id, handle: login, url: connectionProvider('twitch')!.url(login) } };
}

async function readGoogle(ctx: Ctx, creds: Creds, code: string, verifier: string | null): Promise<{ account: RemoteAccount; token: string }> {
  const tok = await http.json('https://oauth2.googleapis.com/token', { form: { client_id: creds.clientId, client_secret: creds.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri(ctx, 'youtube'), ...(verifier ? { code_verifier: verifier } : {}) } });
  const token = tok.status === 200 && typeof tok.body?.access_token === 'string' ? tok.body.access_token : null;
  if (!token) throw new OAuthFlowError('exchange_failed');
  const r = await http.json('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: bearer(token) });
  if (r.status !== 200) throw new OAuthFlowError('account_failed');
  const ch = r.body?.items?.[0];
  if (!ch) throw new OAuthFlowError('no_channel');
  if (typeof ch.id !== 'string' || !/^UC[\w-]{20,24}$/.test(ch.id)) throw new OAuthFlowError('account_failed');
  const custom = typeof ch.snippet?.customUrl === 'string' ? ch.snippet.customUrl : '';
  const handle = connectionProvider('youtube')!.pattern.test(custom) ? custom : ch.id;
  const url = connectionProvider('youtube')!.pattern.test(handle) ? connectionProvider('youtube')!.url(handle) : `https://www.youtube.com/channel/${ch.id}`;
  return { token, account: { id: ch.id, handle, url } };
}

/** Best effort: tokens are never kept, so also tell the provider to forget them. */
function revoke(ctx: Ctx, provider: OAuthConnectionProvider, creds: Creds, token: string) {
  const p = provider === 'twitch'
    ? http.json('https://id.twitch.tv/oauth2/revoke', { form: { client_id: creds.clientId, token } })
    : http.json('https://oauth2.googleapis.com/revoke', { form: { token } });
  void p.catch((e) => ctx.log.debug({ provider, err: String(e?.message ?? e) }, 'oauth token revoke failed')); // never log the token
}

/** Insert or upgrade the user's connection of this provider to a verified one. */
export async function saveVerified(ctx: Ctx, userId: string, provider: OAuthConnectionProvider, acc: RemoteAccount): Promise<string> {
  const [taken] = await ctx.db.query('SELECT user_id FROM connections WHERE type = $1 AND provider_user_id = $2', [provider, acc.id]);
  if (taken && taken.user_id !== userId) throw new OAuthFlowError('already_linked');
  // the same account again, or the user's own self-declared link to that very handle
  const mine = (await ctx.db.query('SELECT * FROM connections WHERE user_id = $1 AND type = $2 AND (provider_user_id = $3 OR (provider_user_id IS NULL AND lower(handle) = lower($4))) ORDER BY (provider_user_id = $3) DESC NULLS LAST, created_at LIMIT 1', [userId, provider, acc.id, acc.handle]))[0];
  try {
    if (mine) { // keep the row (and its visibility), prove it
      const clash = await ctx.db.query('SELECT id FROM connections WHERE user_id = $1 AND type = $2 AND handle = $3 AND id <> $4 AND provider_user_id IS NULL', [userId, provider, acc.handle, mine.id]);
      if (clash.length) await ctx.db.query('DELETE FROM connections WHERE id = $1', [clash[0]!.id]); // an unverified duplicate of the same handle
      await ctx.db.query('UPDATE connections SET handle = $2, url = $3, verified = true, provider_user_id = $4 WHERE id = $1', [mine.id, acc.handle, acc.url, acc.id]);
      return mine.id;
    }
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM connections WHERE user_id = $1', [userId]);
    if (n.n >= MAX_CONNECTIONS) throw new OAuthFlowError('limit_reached');
    const id = snowflake();
    await ctx.db.query('INSERT INTO connections (id, user_id, type, handle, url, visible, verified, verify_token, provider_user_id) VALUES ($1,$2,$3,$4,$5,true,true,$6,$7)', [id, userId, provider, acc.handle, acc.url, randomBytes(9).toString('hex'), acc.id]);
    return id;
  } catch (e: any) {
    if (e instanceof OAuthFlowError) throw e;
    if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw new OAuthFlowError('already_linked'); // lost a race for the same account
    throw e;
  }
}

/**
 * Finishes the flow from the callback. The state is consumed first (single use, so a replayed callback finds nothing), then bound to the
 * browser cookie, then the code is exchanged. Returns the user for logging, throws OAuthFlowError with a reason on any problem.
 */
export async function completeAuthorize(ctx: Ctx, provider: OAuthConnectionProvider, q: { code: string; state: string; nonce: string | null }): Promise<string> {
  const creds = credsFor(ctx, provider); if (!creds) throw new OAuthFlowError('disabled');
  const [row] = await ctx.db.query('DELETE FROM connection_oauth_states WHERE state_hash = $1 AND provider = $2 RETURNING *', [sha(q.state), provider]);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) throw new OAuthFlowError('invalid_state');
  const want = Buffer.from(row.binding_hash, 'hex'), got = Buffer.from(q.nonce ? sha(q.nonce) : '0'.repeat(64), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new OAuthFlowError('invalid_state'); // started in another browser: do not link
  let read: { account: RemoteAccount; token: string };
  try { read = provider === 'twitch' ? await readTwitch(ctx, creds, q.code) : await readGoogle(ctx, creds, q.code, row.code_verifier); }
  catch (e) {
    if (e instanceof OAuthFlowError) throw e;
    ctx.log.warn({ provider, err: e instanceof ProviderError ? e.message : 'unexpected' }, 'connection oauth failed');
    throw new OAuthFlowError('exchange_failed');
  }
  revoke(ctx, provider, creds, read.token);
  await saveVerified(ctx, row.user_id, provider, read.account);
  void refreshUserEverywhere(ctx, row.user_id).catch(() => {}); // linked roles that need a verified connection
  return row.user_id;
}

export const parseCookie = (header: string | undefined, name: string): string | null => {
  for (const part of (header ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null; }
  return null;
};
