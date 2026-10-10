import { create } from 'zustand';
import { bindTokenStore } from '@/lib/transport';
import { syncActiveTokens } from '@/lib/accounts';

interface AuthState { access: string | null; refresh: string | null; set(a: string | null, r: string | null): void; clear(): void }
const KEY = 'jorcord.auth.v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}; } catch { return {}; } };
const persist = (a: string | null, r: string | null) => { try { a ? localStorage.setItem(KEY, JSON.stringify({ access: a, refresh: r })) : localStorage.removeItem(KEY); } catch { /* */ } };

export const useAuth = create<AuthState>((set) => ({
  access: load().access ?? null, refresh: load().refresh ?? null,
  set: (access, refresh) => { persist(access, refresh); syncActiveTokens(access, refresh); set({ access, refresh }); },
  clear: () => { persist(null, null); set({ access: null, refresh: null }); },
}));

bindTokenStore({
  get: () => ({ access: useAuth.getState().access, refresh: useAuth.getState().refresh }),
  set: (a, r) => useAuth.getState().set(a, r),
  onLogout: () => useAuth.getState().clear(),
});
