/** Pure speaking-state reducer with hangover so indicators don't flicker. */
export interface SpeakerEntry { level: number; speaking: boolean; lastActiveAt: number }
export interface SpeakingState { speakers: Record<string, SpeakerEntry> }
export const SPEAKING_HANGOVER_MS = 350;
export const SPEAKING_THRESHOLD = 0.02;

export type SpeakingAction =
  | { type: 'levels'; now: number; levels: Record<string, number>; threshold?: number }
  | { type: 'tick'; now: number; hangoverMs?: number }
  | { type: 'remove'; id: string }
  | { type: 'reset' };

export const initialSpeaking: SpeakingState = { speakers: {} };

export function speakingReducer(state: SpeakingState, a: SpeakingAction): SpeakingState {
  switch (a.type) {
    case 'levels': {
      const thr = a.threshold ?? SPEAKING_THRESHOLD;
      const next: Record<string, SpeakerEntry> = { ...state.speakers };
      for (const [id, level] of Object.entries(a.levels)) {
        const prev = next[id];
        const active = level >= thr;
        next[id] = { level, speaking: active || (prev?.speaking ?? false), lastActiveAt: active ? a.now : prev?.lastActiveAt ?? 0 };
      }
      return { speakers: next };
    }
    case 'tick': {
      const hang = a.hangoverMs ?? SPEAKING_HANGOVER_MS;
      let changed = false;
      const next: Record<string, SpeakerEntry> = {};
      for (const [id, e] of Object.entries(state.speakers)) {
        if (e.speaking && a.now - e.lastActiveAt > hang) { next[id] = { ...e, speaking: false, level: 0 }; changed = true; }
        else next[id] = e;
      }
      return changed ? { speakers: next } : state;
    }
    case 'remove': {
      if (!(a.id in state.speakers)) return state;
      const { [a.id]: _, ...rest } = state.speakers;
      return { speakers: rest };
    }
    case 'reset': return initialSpeaking;
  }
}

export const isSpeaking = (s: SpeakingState, id: string) => !!s.speakers[id]?.speaking;
export const speakingIds = (s: SpeakingState) => Object.keys(s.speakers).filter((k) => s.speakers[k]!.speaking);
