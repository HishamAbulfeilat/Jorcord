import { create } from 'zustand';
import type { StreamSource } from '@jorcord/voice';
import type { ClipWindow, SavedClip } from '@/voice/clipBuffer';

/** Transient clip-recorder state (the Blob lives here, not in persisted prefs). */
interface ClipUIState {
  buffering: boolean; ended: boolean; source: StreamSource; windowSec: ClipWindow;
  /** The clip waiting in the preview dialog. */
  clip: SavedClip | null;
  patch(p: Partial<Omit<ClipUIState, 'patch'>>): void;
}
export const useClipUI = create<ClipUIState>((set) => ({
  buffering: false, ended: false, source: 'screen', windowSec: 30, clip: null,
  patch: (p) => set(p),
}));
