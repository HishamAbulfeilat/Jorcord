import { create } from 'zustand';
import { bindTokenStore } from '@/lib/transport';
import { syncActiveTokens } from '@/lib/accounts';
import { AUTH_KEY, loadAuth, saveAuth } from '@/lib/authStorage';

interface AuthState {
  access: string | null; refresh: string | null; set(a: string | null, r: string | null): void; clear(): void;
  /** Adopt tokens another tab already rotated into storage. True when they differed from ours. */
  reload(): boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  access: loadAuth().access ?? null, refresh: loadAuth().refresh ?? null,
  set: (access, refresh) => { saveAuth(access, refresh); syncActiveTokens(access, refresh); set({ access, refresh }); },
  clear: () => { saveAuth(null, null); set({ access: null, refresh: null }); },
  reload: () => {
    const s = loadAuth();
    if (!s.access || !s.refresh || s.refresh === get().refresh) return false;
    set({ access: s.access, refresh: s.refresh }); return true;
  },
}));

bindTokenStore({
  get: () => ({ access: useAuth.getState().access, refresh: useAuth.getState().refresh }),
  set: (a, r) => useAuth.getState().set(a, r),
  onLogout: () => useAuth.getState().clear(),
  reload: () => useAuth.getState().reload(),
});

// Refresh tokens rotate (a replayed one kills the session), so a tab must follow the rotation another tab just did.
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === AUTH_KEY && e.newValue) useAuth.getState().reload(); });
