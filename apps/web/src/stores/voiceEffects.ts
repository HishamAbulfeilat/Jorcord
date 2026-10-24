/** Emoji bursts floating over participant tiles (VOICE_CHANNEL_EFFECT_SEND with an `emoji`). Short-lived, never persisted. */
import { create } from 'zustand';
import type { Id } from '@jorcord/shared';

export interface VoiceEffect { id: number; userId: Id; emoji: string; emojiId: Id | null }
export const EFFECT_MS = 2800;
const MAX_ACTIVE = 24;
let seq = 0;

interface S {
  effects: VoiceEffect[];
  add(userId: Id, emoji: string, emojiId: Id | null): void;
  remove(id: number): void;
  clear(): void;
}
export const useVoiceEffects = create<S>((set, get) => ({
  effects: [],
  add: (userId, emoji, emojiId) => {
    const id = ++seq;
    set((s) => ({ effects: [...s.effects, { id, userId, emoji, emojiId }].slice(-MAX_ACTIVE) }));
    setTimeout(() => get().remove(id), EFFECT_MS + 200);
  },
  remove: (id) => set((s) => (s.effects.some((e) => e.id === id) ? { effects: s.effects.filter((e) => e.id !== id) } : s)),
  clear: () => set({ effects: [] }),
}));
