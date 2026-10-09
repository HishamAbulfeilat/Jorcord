import { create } from 'zustand';
/** Local mute/deafen UI state. The voice module (src/voice) may read/write this to sync with LiveKit. */
export const useVoiceUI = create<{ selfMute: boolean; selfDeaf: boolean; toggleMute(): void; toggleDeaf(): void; connectedChannelId: string | null; setConnected(id: string | null): void }>((set) => ({
  selfMute: false, selfDeaf: false, connectedChannelId: null,
  toggleMute: () => set((s) => ({ selfMute: !s.selfMute })),
  toggleDeaf: () => set((s) => ({ selfDeaf: !s.selfDeaf, selfMute: !s.selfDeaf ? true : s.selfMute })),
  setConnected: (connectedChannelId) => set({ connectedChannelId }),
}));
