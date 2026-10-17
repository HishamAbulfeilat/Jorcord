/** Soundboard playback: clips are played locally on each listener's machine (the server relays who played what). */
import type { Events, Id } from '@jorcord/shared';
import { fileUrl } from './format';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';

/** Should I hear this effect? Only in my current call, never while deafened, and respecting my own and per-person soundboard mutes. */
export function shouldPlayEffect(d: Events['VOICE_CHANNEL_EFFECT_SEND'], me: Id | undefined): boolean {
  const v = useVoiceUI.getState(); const p = useUI.getState().prefs;
  if (v.connectedChannelId !== d.channelId || v.selfDeaf) return false;
  if (p.soundboardMuted || (d.userId !== me && p.soundboardMutedUsers[d.userId])) return false;
  return true;
}
export function playClip(url: string, volume: number) {
  try {
    const a = new Audio(fileUrl(url) ?? url);
    a.volume = Math.max(0, Math.min(1, volume * (useUI.getState().prefs.soundboardVolume / 100) * (useUI.getState().prefs.outputVolume / 100)));
    void a.play().catch(() => {});
  } catch { /* autoplay blocked */ }
}
export function onVoiceEffect(d: Events['VOICE_CHANNEL_EFFECT_SEND'], me: Id | undefined) {
  if (shouldPlayEffect(d, me)) playClip(d.sound.url, d.sound.volume);
}
