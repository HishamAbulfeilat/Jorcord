/**
 * Where the login tokens live. "Remember me" (default, and what every session before this option existed did) keeps them in localStorage, which
 * survives closing the tab, the browser and the Tauri / Capacitor app (their WebViews persist it in the app's data directory). Unchecked keeps them
 * in sessionStorage only, so they vanish with the tab. Every access is guarded: storage can throw (private mode, quota, blocked cookies).
 */
export const AUTH_KEY = 'jorcord.auth.v1';
const REMEMBER_KEY = 'jorcord.remember';

export interface StoredAuth { access?: string | null; refresh?: string | null }

export function getRemember(): boolean {
  try { return localStorage.getItem(REMEMBER_KEY) !== '0'; } catch { return true; }
}
export function setRemember(on: boolean) {
  try { localStorage.setItem(REMEMBER_KEY, on ? '1' : '0'); } catch { /* */ }
}

export function loadAuth(): StoredAuth {
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
  const [keep, drop] = getRemember() ? (['localStorage', 'sessionStorage'] as const) : (['sessionStorage', 'localStorage'] as const);
  try { window[drop].removeItem(AUTH_KEY); } catch { /* */ }
  try { access ? window[keep].setItem(AUTH_KEY, JSON.stringify({ access, refresh })) : window[keep].removeItem(AUTH_KEY); } catch { /* */ }
}
