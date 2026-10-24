import { useRef, useState, useSyncExternalStore } from 'react';
import { Mic } from 'lucide-react';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { useUI } from '@/stores/ui';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

/** True on touch-first devices, where there is no keyboard key to hold. */
const Q = '(pointer: coarse)';
const mm = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(Q) : null);
export const useCoarsePointer = () => useSyncExternalStore(
  (cb) => { const m = mm(); m?.addEventListener('change', cb); return () => m?.removeEventListener('change', cb); },
  () => !!mm()?.matches, () => false);

/**
 * Press and hold to talk. It drives the voice client's existing push-to-talk through the same key events the keyboard
 * uses (the configured PTT key, including the release delay), so there is one PTT code path. Shown on touch devices
 * while Push to Talk is the input mode.
 */
export function PttButton({ className, force }: { className?: string; /** tests / always show */ force?: boolean }) {
  const coarse = useCoarsePointer(); const ptt = useUI((s) => s.prefs.pushToTalk); const code = useUI((s) => s.prefs.pttCode);
  const snap = useVoiceSnapshot();
  const [down, setDown] = useState(false); const held = useRef(false);
  if (!(force || coarse) || !ptt) return null;
  const press = () => { if (held.current) return; held.current = true; setDown(true); navigator.vibrate?.(10); window.dispatchEvent(new KeyboardEvent('keydown', { code })); };
  const release = () => { if (!held.current) return; held.current = false; setDown(false); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const live = down || snap.pttActive;
  return (
    <button type="button" data-testid="ptt-button" aria-label={t('Hold to talk')} aria-pressed={live}
      onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); press(); }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onContextMenu={(e) => e.preventDefault()}
      className={cx('touch flex min-h-[56px] w-full select-none items-center justify-center gap-2 rounded-lg text-sm font-bold [touch-action:none]', live ? 'bg-success text-white' : 'bg-[rgb(var(--active))] text-header', className)}>
      <Mic size={20} />{live ? t('Talking…') : t('Hold to talk')}
    </button>
  );
}
