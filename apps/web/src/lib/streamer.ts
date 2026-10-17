import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';

/** Streamer mode is on when switched on manually, or automatically while this user is screen-sharing ("Go Live"). */
export function streamerActive(): boolean {
  const p = useUI.getState().prefs;
  return p.streamerMode || (p.streamerAuto && useVoiceUI.getState().streaming);
}
export function useStreamer() {
  const p = useUI((s) => s.prefs); const live = useVoiceUI((s) => s.streaming);
  const on = p.streamerMode || (p.streamerAuto && live);
  return { on, hidePersonal: on && p.streamerHidePersonal, hideInvites: on && p.streamerHideInvites, noSounds: on && p.streamerNoSounds, noNotifications: on && p.streamerNoNotifications };
}
export const maskEmail = (e: string) => { const [u, d] = e.split('@'); return d ? `${u![0]}${'•'.repeat(Math.max(3, (u?.length ?? 1) - 1))}@${d}` : '••••••'; };
