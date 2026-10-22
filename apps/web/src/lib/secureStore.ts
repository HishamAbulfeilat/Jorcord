/** Leaf module (imports nothing heavy) so storage code can use the desktop bridge without pulling in the stores. */
import { isTauri } from './server';

const tauri = (): any => (window as any).__TAURI__;

export const invokeFn = (): ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null => {
  const t = tauri(); const f = t?.core?.invoke ?? t?.invoke ?? (window as any).__TAURI_INTERNALS__?.invoke;
  return typeof f === 'function' ? f : null;
};

/**
 * OS keychain for the login tokens (desktop only). `get` is null when nothing is stored, `ok` false when there is no keychain at all
 * (browser, or the OS service is missing / locked): callers then keep using web storage.
 */
export const secureStore = {
  available: () => isTauri() && !!invokeFn(),
  async get(name: 'auth' | 'accounts'): Promise<{ ok: boolean; value: string | null }> {
    const inv = invokeFn(); if (!isTauri() || !inv) return { ok: false, value: null };
    try { return { ok: true, value: (await inv('secure_get', { name })) ?? null }; } catch { return { ok: false, value: null }; }
  },
  async set(name: 'auth' | 'accounts', value: string): Promise<boolean> {
    const inv = invokeFn(); if (!isTauri() || !inv) return false;
    try { await inv('secure_set', { name, value }); return true; } catch { return false; }
  },
  async delete(name: 'auth' | 'accounts'): Promise<boolean> {
    const inv = invokeFn(); if (!isTauri() || !inv) return false;
    try { await inv('secure_delete', { name }); return true; } catch { return false; }
  },
};
