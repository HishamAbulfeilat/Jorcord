import { create } from 'zustand';
import { reduceCaptions, pruneCaptions, type CaptionLine, type CaptionState } from '@/voice/captions';

interface CaptionsStore {
  lines: CaptionLine[]; state: CaptionState;
  push(t: { speaker: string; text: string; final: boolean }, now?: number): void;
  prune(now?: number): void; setState(s: CaptionState): void; clear(): void;
}
export const useCaptions = create<CaptionsStore>((set) => ({
  lines: [], state: 'off',
  push: (t, now = Date.now()) => set((s) => ({ lines: reduceCaptions(s.lines, { ...t, at: now }) })),
  prune: (now = Date.now()) => set((s) => { const l = pruneCaptions(s.lines, now); return l === s.lines ? s : { lines: l }; }),
  setState: (state) => set({ state }),
  clear: () => set({ lines: [] }),
}));
