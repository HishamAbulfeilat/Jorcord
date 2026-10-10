/** Saved-for-later marks (message ids) and due-reminder state. Server is the source of truth; this mirrors it. */
import { create } from 'zustand';
import type { Id } from '@jorcord/shared';
import { api } from '@/lib/api';

interface SocialState {
  saved: Record<Id, true>; savedLoaded: boolean;
  setSaved(messageId: Id, on: boolean): void;
  load(): Promise<void>;
  reset(): void;
}
export const useSocial = create<SocialState>((set, get) => ({
  saved: {}, savedLoaded: false,
  setSaved: (id, on) => set((s) => { const saved = { ...s.saved }; if (on) saved[id] = true; else delete saved[id]; return { saved }; }),
  async load() { try { const ids = await api.users.savedIds(); set({ saved: Object.fromEntries(ids.map((i) => [i, true as const])), savedLoaded: true }); } catch { /* older server */ } void get; },
  reset: () => set({ saved: {}, savedLoaded: false }),
}));
