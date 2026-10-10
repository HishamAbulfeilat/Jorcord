/**
 * Multi-account switcher. The browser keeps one *active* session (stores/auth) plus a list of other signed-in accounts for the same server.
 * Switching swaps the stored tokens and reloads the app, so no data of one account can leak into another's stores or caches.
 */
import { getServerUrl } from './server';

export interface SavedAccount { id: string; username: string; displayName: string | null; avatar: string | null; access: string; refresh: string | null; server: string; addedAt: number }
const KEY = 'jorcord.accounts.v1'; const ACTIVE = 'jorcord.accounts.active';
const server = () => { try { return getServerUrl() || ''; } catch { return ''; } };

export function loadAccounts(): SavedAccount[] {
  try { const l = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(l) ? l.filter((a) => a && typeof a.id === 'string' && typeof a.access === 'string') : []; } catch { return []; }
}
const save = (l: SavedAccount[]) => { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* private mode: switching is simply unavailable */ } };
export const activeAccountId = (): string | null => { try { return localStorage.getItem(ACTIVE); } catch { return null; } };
const setActive = (id: string | null) => { try { id ? localStorage.setItem(ACTIVE, id) : localStorage.removeItem(ACTIVE); } catch { /* */ } };
/** Accounts of the server this app talks to (a wrapper can switch servers). */
export const accountsHere = () => loadAccounts().filter((a) => a.server === server());

/** Record the signed-in user (called whenever `GET /users/@me` succeeds) and mark it active. */
export function rememberAccount(u: { id: string; username: string; displayName: string | null; avatar: string | null }, tokens: { access: string | null; refresh: string | null }) {
  if (!tokens.access) return;
  const rest = loadAccounts().filter((a) => !(a.id === u.id && a.server === server()));
  const prev = loadAccounts().find((a) => a.id === u.id && a.server === server());
  save([...rest, { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, access: tokens.access, refresh: tokens.refresh, server: server(), addedAt: prev?.addedAt ?? Date.now() }]);
  setActive(u.id);
}
/** Refresh tokens rotate: keep the stored copy of the active account current. */
export function syncActiveTokens(access: string | null, refresh: string | null) {
  const id = activeAccountId(); if (!id || !access) return;
  save(loadAccounts().map((a) => (a.id === id && a.server === server() ? { ...a, access, refresh } : a)));
}
export function forgetAccount(id: string) { save(loadAccounts().filter((a) => !(a.id === id && a.server === server()))); if (activeAccountId() === id) setActive(null); }

/** Swap to another saved account and reload. */
export function switchAccount(id: string, setTokens: (a: string, r: string | null) => void) {
  const acc = accountsHere().find((a) => a.id === id); if (!acc) return false;
  setActive(acc.id); // before the tokens change: the auth store mirrors new tokens into the *active* account's entry
  setTokens(acc.access, acc.refresh);
  location.assign('/channels/@me');
  return true;
}
/**
 * Open the login form to add another account. The current session stays signed in (so abandoning the form loses nothing); the login route
 * accepts `?add=1` even when signed in, and a successful login becomes the active account via rememberAccount().
 */
export function beginAddAccount() { setActive(null); location.assign('/login?add=1'); }
