/** OAuth2 helpers shared by the developer portal's URL generator and the /oauth2/authorize page. */
import { OAuthScopes, Perm } from '@jorcord/shared';
import type { OAuthScope, PermName } from '@jorcord/shared';

export const SCOPE_INFO: Record<OAuthScope, { label: string; desc: string }> = {
  bot: { label: 'Add a bot to a server', desc: 'Adds the application\'s bot user to a server you manage.' },
  'applications.commands': { label: 'Create commands in a server', desc: 'Lets the application add slash commands to a server.' },
  identify: { label: 'Access your username and avatar', desc: 'Lets the application see who you are.' },
};

export const hasScope = (scopes: string[], s: OAuthScope) => scopes.includes(s);
export const needsGuild = (scopes: string[]) => hasScope(scopes, 'bot') || hasScope(scopes, 'applications.commands');

/** Bits -> permission names in bit order. Unknown bits are ignored. */
export function permissionNames(bits: string | bigint): PermName[] {
  let b: bigint; try { b = BigInt(bits || 0); } catch { b = 0n; }
  return (Object.keys(Perm) as PermName[]).filter((n) => (b & Perm[n]) !== 0n).sort((x, y) => (Perm[x] < Perm[y] ? -1 : 1));
}
export function permissionBits(names: Iterable<PermName>): string {
  let b = 0n; for (const n of names) b |= Perm[n]; return b.toString();
}

export interface AuthorizeQuery { clientId: string; scopes: string[]; permissions: string; guildId?: string; redirectUri?: string; state?: string }
/** Accepts Discord's snake_case (`client_id`, `redirect_uri`, `guild_id`) and our camelCase; scopes may be space, comma or `+` separated. */
export function parseAuthorizeQuery(search: string): AuthorizeQuery {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const get = (...k: string[]) => { for (const x of k) { const v = q.get(x); if (v) return v; } return undefined; };
  const scopes = (get('scope', 'scopes') ?? '').split(/[\s,+]+/).filter(Boolean);
  const perms = get('permissions') ?? '0';
  return { clientId: get('client_id', 'clientId') ?? '', scopes: [...new Set(scopes)], permissions: /^\d{1,20}$/.test(perms) ? perms : '0', guildId: get('guild_id', 'guildId'), redirectUri: get('redirect_uri', 'redirectUri'), state: get('state') };
}

export function buildAuthorizeUrl(origin: string, q: { clientId: string; scopes: string[]; permissions?: string; redirectUri?: string; state?: string }): string {
  const p = new URLSearchParams();
  p.set('client_id', q.clientId);
  p.set('scope', q.scopes.join(' '));
  if (q.scopes.includes('bot') && q.permissions && q.permissions !== '0') p.set('permissions', q.permissions);
  if (q.redirectUri) { p.set('redirect_uri', q.redirectUri); p.set('response_type', 'code'); }
  if (q.state) p.set('state', q.state);
  return `${origin.replace(/\/$/, '')}/oauth2/authorize?${p.toString().replace(/\+/g, '%20')}`;
}

export const validScopes = (scopes: string[]): scopes is OAuthScope[] => scopes.length > 0 && scopes.every((s) => (OAuthScopes as readonly string[]).includes(s));

/** Where to send the browser after an `identify` authorization: redirect_uri?code=..&state=.. */
export function redirectWithCode(redirectUri: string, code: string, state?: string): string {
  const u = new URL(redirectUri); u.searchParams.set('code', code); if (state) u.searchParams.set('state', state); return u.toString();
}
