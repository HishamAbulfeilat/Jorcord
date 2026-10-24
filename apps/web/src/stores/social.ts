/** Saved-for-later marks (message ids) and due-reminder state. Server is the source of truth; this mirrors it. */
import { create } from 'zustand';
import type { Id } from '@jorcord/shared';
import { api } from '@/lib/api';
import { api3c } from '@/lib/api3c';

interface SocialState {
  saved: Record<Id, true>; savedLoaded: boolean;
  /** People I ignore: their messages are folded away and they never ping me (distinct from block). */
  ignored: Record<Id, true>;
  setIgnored(userId: Id, on: boolean): void;
  setSaved(messageId: Id, on: boolean): void;
  load(): Promise<void>;
  reset(): void;
}
export const useSocial = create<SocialState>((set, get) => ({
  saved: {}, savedLoaded: false, ignored: {},
  setIgnored: (id, on) => set((s) => { const ignored = { ...s.ignored }; if (on) ignored[id] = true; else delete ignored[id]; return { ignored }; }),
  setSaved: (id, on) => set((s) => { const saved = { ...s.saved }; if (on) saved[id] = true; else delete saved[id]; return { saved }; }),
  async load() { try { const ids = await api.users.savedIds(); set({ saved: Object.fromEntries(ids.map((i) => [i, true as const])), savedLoaded: true }); } catch { /* older server */ } try { const users = await api3c.ignored(); set({ ignored: Object.fromEntries(users.map((u) => [u.id, true as const])) }); } catch { /* older server */ } void get; },
  reset: () => set({ saved: {}, savedLoaded: false, ignored: {} }),
}));
