import { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import type { StreamSource } from '@jorcord/voice';
import { Toggle } from '@/components/ui/primitives';
import { Tip } from '@/components/ui/Tooltip';
import { toastError, useUI } from '@/stores/ui';
import { useClipUI } from '@/stores/clipui';
import { cx } from '@/lib/format';
import { t } from '@/i18n';
import { CLIP_WINDOWS, getShareMax, type ClipWindow } from './clipBuffer';
import { loadClipLimits } from './clipLimits';
import { clipAvailableSec, clipsSupported, saveClip, startClipBuffer, stopClipBuffer } from './clips';

const label = (w: number) => (w === 60 ? '1 min' : w === 120 ? '2 min' : `${w} s`);

/** Rolling-buffer clip recorder for my own screen share or camera. Everything stays on this device until I choose to share. */
export function ClipButton() {
  const snap = useVoiceSnapshot(); const ui = useClipUI(); const prefs = useUI((s) => s.prefs); const setPref = useUI((s) => s.setPref);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const live = snap.screenOn || snap.cameraOn;
  const source: StreamSource = ui.buffering ? ui.source : snap.screenOn ? 'screen' : 'camera';
  const sourceOn = source === 'screen' ? snap.screenOn : snap.cameraOn;
  const windowSec = (ui.buffering ? ui.windowSec : prefs.clipWindow) as ClipWindow;

  useEffect(() => { if (open) void loadClipLimits().then(() => tick((n) => n + 1)); }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    const id = setInterval(() => tick((n) => n + 1), 1000); // live "ready" counter
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); clearInterval(id); };
  }, [open]);
  // opt-in auto start when a stream begins
  useEffect(() => { if (prefs.clipAutoBuffer && clipsSupported() && !ui.buffering && sourceOn) { try { startClipBuffer(source, prefs.clipWindow); useClipUI.getState().patch({ ended: false }); } catch { /* the popover shows errors on demand */ } } }, [prefs.clipAutoBuffer, sourceOn]); // eslint-disable-line

  if (!live && !ui.buffering) return null;
  const supported = clipsSupported();
  const ready = ui.buffering ? Math.floor(clipAvailableSec()) : 0;

  const start = () => { try { startClipBuffer(source, windowSec); useClipUI.getState().patch({ ended: false }); setPref('clipWindow', windowSec); } catch (e) { toastError(e); } };
  const save = async () => {
    setBusy(true);
    try { await saveClip(); setOpen(false); useUI.getState().openModal({ kind: 'clipPreview' }); } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  return (
    <div className="relative" ref={box}>
      <Tip text={t('Clips')} side="top">
        <button aria-label={t('Clips')} aria-expanded={open} aria-haspopup="dialog" data-testid="clip-button" onClick={() => setOpen((v) => !v)}
          className={cx('flex h-12 w-12 items-center justify-center rounded-full transition-colors max-md:h-11 max-md:w-11', ui.buffering ? 'bg-white text-black hover:bg-white/90' : 'bg-[rgb(var(--active))] text-header hover:bg-[rgb(var(--divider))]')}>
          <Film size={22} />{ui.buffering && !ui.ended && <span aria-hidden className="absolute end-0 top-0 h-3 w-3 rounded-full bg-danger ring-2 ring-[rgb(var(--chat))]" />}
        </button>
      </Tip>
      {open && (
        <div role="dialog" aria-label={t('Clip recorder')} data-testid="clip-popover" className="absolute bottom-14 start-1/2 z-30 w-[300px] -translate-x-1/2 rounded-xl bg-float p-4 text-sm shadow-elev">
          {!supported ? <p role="alert" data-testid="clip-unsupported" className="text-muted">{t('Your browser cannot record clips (MediaRecorder is not available).')}</p> : (<>
            <p className="mb-2 text-muted">{t('Keeps a rolling recording of your own stream on this device. Nothing is uploaded until you share a clip.')}</p>
            <fieldset className="mb-3" disabled={ui.buffering}>
              <legend className="label">{t('Record')}</legend>
              <div className="flex gap-2">{(['screen', 'camera'] as const).map((s) => {
                const on = s === 'screen' ? snap.screenOn : snap.cameraOn;
                return <label key={s} className={cx('flex-1 cursor-pointer rounded border-2 px-2 py-1 text-center', source === s ? 'border-brand' : 'border-divider', !on && 'opacity-40')}>
                  <input type="radio" className="sr-only" name="clip-source" checked={source === s} disabled={!on} onChange={() => useClipUI.getState().patch({ source: s })} />{s === 'screen' ? t('Screen share') : t('Camera')}</label>;
              })}</div>
            </fieldset>
            <fieldset className="mb-3" disabled={ui.buffering}>
              <legend className="label">{t('Keep the last')}</legend>
              <div role="radiogroup" className="flex gap-2">{CLIP_WINDOWS.map((w) => (
                <label key={w} className={cx('flex-1 cursor-pointer rounded border-2 px-2 py-1 text-center', windowSec === w ? 'border-brand' : 'border-divider')}>
                  <input type="radio" className="sr-only" name="clip-window" checked={windowSec === w} onChange={() => { setPref('clipWindow', w); useClipUI.getState().patch({ windowSec: w }); }} aria-label={label(w)} />{label(w)}</label>))}
              </div>
              {windowSec > getShareMax() && <p className="mt-1 text-xs text-muted">{t('Longer clips can be downloaded; sharing to a clips channel is limited to {n} seconds.').replace('{n}', String(getShareMax()))}</p>}
            </fieldset>
            {!ui.buffering
              ? <button className="btn btn-primary w-full" disabled={!sourceOn} onClick={start}>{t('Start recording buffer')}</button>
              : (<>
                <p role="status" data-testid="clip-status" className="mb-2 text-header">{ui.ended ? t('Stream ended.') : t('Recording')} {t('{n} s ready').replace('{n}', String(ready))}</p>
                <div className="flex gap-2">
                  <button className="btn btn-primary flex-1" disabled={busy || ready < 2} onClick={() => void save()}>{busy ? t('Saving…') : t('Save clip')}</button>
                  <button className="btn btn-secondary" onClick={() => { stopClipBuffer(); useClipUI.getState().patch({ ended: false }); }}>{t('Stop')}</button>
                </div></>)}
            <div className="mt-3 flex items-center justify-between"><span className="text-header">{t('Start automatically')}</span><Toggle label={t('Start clip buffer automatically')} checked={prefs.clipAutoBuffer} onChange={(v) => setPref('clipAutoBuffer', v)} /></div>
          </>)}
        </div>
      )}
    </div>
  );
}
