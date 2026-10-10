import { create } from 'zustand';

export type VoiceConn = 'idle' | 'connecting' | 'connected' | 'reconnecting';
interface VoiceUIState {
  /** Self mute/deafen. Mirrors the live VoiceClient while connected; remembered locally while not. */
  selfMute: boolean; selfDeaf: boolean;
  connectedChannelId: string | null;
  conn: VoiceConn;
  /** Optimistic: channel we are currently joining. */
  joiningChannelId: string | null;
  /** Spotlighted participant tile ("identity:camera|screen"). */
  focus: string | null;
  setFocus(k: string | null): void;
  /** Local screen share is live (mirrors the client; used by streamer mode). */
  streaming: boolean;
  /** "Go Live" quality popover, opened from several entry points. `barMounted` = the channel's control bar renders it, else the dock does. */
  sharePop: boolean; barMounted: boolean; setSharePop(v: boolean): void; setBarMounted(v: boolean): void;
  toggleMute(): void; toggleDeaf(): void;
  setConnected(id: string | null): void;
  patch(p: Partial<Pick<VoiceUIState, 'selfMute' | 'selfDeaf' | 'conn' | 'joiningChannelId' | 'streaming'>>): void;
}

/** Actions (set by src/voice/controller) that forward to the live client when connected. */
export const voiceHooks: { toggleMute?: () => void; toggleDeaf?: () => void } = {};

export const useVoiceUI = create<VoiceUIState>((set, get) => ({
  selfMute: false, selfDeaf: false, connectedChannelId: null, conn: 'idle', joiningChannelId: null, focus: null, streaming: false, sharePop: false, barMounted: false,
  setSharePop: (sharePop) => set({ sharePop }), setBarMounted: (barMounted) => set({ barMounted }),
  setFocus: (focus) => set({ focus }),
  toggleMute: () => { if (get().conn !== 'idle' && voiceHooks.toggleMute) voiceHooks.toggleMute(); else set((s) => ({ selfMute: s.selfDeaf ? false : !s.selfMute, selfDeaf: s.selfDeaf ? false : s.selfDeaf })); },
  toggleDeaf: () => { if (get().conn !== 'idle' && voiceHooks.toggleDeaf) voiceHooks.toggleDeaf(); else set((s) => ({ selfDeaf: !s.selfDeaf })); },
  setConnected: (connectedChannelId) => set({ connectedChannelId }),
  patch: (p) => set(p),
}));

/** Effective "muted" for UI: deafened implies muted. */
export const isMutedUI = (s: Pick<VoiceUIState, 'selfMute' | 'selfDeaf'>) => s.selfMute || s.selfDeaf;
