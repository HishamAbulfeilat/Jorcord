import { MicOff } from 'lucide-react';
import { useVoiceUI } from '@/stores/voiceui';
import { t } from '@/i18n';

/**
 * "You are muted" hint: shown for a few seconds when the microphone picks up speech while I am muted. The audio is only measured
 * on this device (see Voice settings > "Warn me when I speak while muted"). Not shown while deafened.
 */
export function MutedSpeakingHint() {
  const on = useVoiceUI((s) => s.speakingWhileMuted && s.selfMute && !s.selfDeaf);
  const toggleMute = useVoiceUI((s) => s.toggleMute);
  if (!on) return null;
  return (
    <div role="status" aria-live="polite" data-testid="muted-hint"
      className="fixed bottom-24 start-1/2 z-[70] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-lg bg-float px-4 py-2 text-sm text-header shadow-elev">
      <MicOff size={18} className="shrink-0 text-danger" aria-hidden />
      <span className="min-w-0">{t('You are muted. Nobody can hear you.')}</span>
      <button className="btn btn-primary shrink-0" onClick={toggleMute}>{t('Unmute')}</button>
    </div>
  );
}
