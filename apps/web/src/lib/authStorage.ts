/**
 * Where the login tokens live. "Remember me" (default, and what every session before this option existed did) keeps them in localStorage, which
 * survives closing the tab, the browser and the Tauri / Capacitor app (their WebViews persist it in the app's data directory). Unchecked keeps them
 * in sessionStorage only, so they vanish with the tab. Every access is guarded: storage can throw (private mode, quota, blocked cookies).
 *
 * Desktop (Tauri): when the OS keychain works, the tokens live there instead (`hydrateSecureAuth` at boot, `saveAuth` mirrors every change) and the
 * web-storage copy is removed. If the keychain errors at any point we keep using web storage, so a missing Secret Service never locks anyone out.
 */
import { secureStore } from './secureStore';

export const AUTH_KEY = 'jorcord.auth.v1';
const REMEMBER_KEY = 'jorcord.remember';

export interface StoredAuth { access?: string | null; refresh?: string | null }

export function getRemember(): boolean {
  try { return localStorage.getItem(REMEMBER_KEY) !== '0'; } catch { return true; }
}
export function setRemember(on: boolean) {
  try { localStorage.setItem(REMEMBER_KEY, on ? '1' : '0'); } catch { /* */ }
}

/** In-memory copy of what the keychain holds; non-null only while the keychain is the source of truth. */
let vault: StoredAuth | null = null;
export const keychainActive = () => vault !== null;
/** Tests only. */
export function _resetVault() { vault = null; }

/**
 * Desktop boot step (await before rendering). Reads the keychain; tokens found in web storage (older installs, or after a keychain failure) are moved
 * into it. Returns true when the keychain is now in charge.
 */
export async function hydrateSecureAuth(): Promise<boolean> {
  if (!secureStore.available()) return false;
  const r = await secureStore.get('auth');
  if (!r.ok) return false;
  let stored: StoredAuth | null = null;
  try { const v = r.value ? JSON.parse(r.value) : null; if (v && typeof v.access === 'string') stored = v; } catch { /* corrupt entry: ignore */ }
  if (!stored) {
    const web = loadAuth(); // vault is still null here, so this reads web storage
    if (web.access) {
      if (!(await secureStore.set('auth', JSON.stringify(web)))) return false;
      stored = web;
    }
  }
  vault = stored ?? {};
  for (const store of ['sessionStorage', 'localStorage'] as const) { try { window[store].removeItem(AUTH_KEY); } catch { /* */ } }
  return true;
}

export function loadAuth(): StoredAuth {
  if (vault) return vault.access ? vault : {};
  for (const store of ['sessionStorage', 'localStorage'] as const) {
    try {
      const v = JSON.parse(window[store].getItem(AUTH_KEY) ?? 'null');
      if (v && typeof v.access === 'string') return v;
    } catch { /* */ }
  }
  return {};
}

/** Write the tokens to the one store the current "remember" choice selects and make sure the other holds nothing. `null` (logout) clears both. */
export function saveAuth(access: string | null, refresh: string | null) {
  if (vault) {
    vault = access ? { access, refresh } : {};
    const snapshot = vault;
    void (access ? secureStore.set('auth', JSON.stringify(snapshot)) : secureStore.delete('auth')).then((ok) => {
      if (ok || vault !== snapshot) return;
      vault = null; // keychain failed mid-session: fall back to web storage from now on
      saveAuth(snapshot.access ?? null, snapshot.refresh ?? null);
    });
    return;
  }
  const [keep, drop] = getRemember() ? (['localStorage', 'sessionStorage'] as const) : (['sessionStorage', 'localStorage'] as const);
  try { window[drop].removeItem(AUTH_KEY); } catch { /* */ }
  try { access ? window[keep].setItem(AUTH_KEY, JSON.stringify({ access, refresh })) : window[keep].removeItem(AUTH_KEY); } catch { /* */ }
}
