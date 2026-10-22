import { useEffect } from 'react';
import { Captions as CaptionsIcon } from 'lucide-react';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { useCaptions } from '@/stores/captions';
import { useUI } from '@/stores/ui';
import { useData } from '@/stores/data';
import { displayName } from '@/lib/format';
import { t } from '@/i18n';
import { CaptionEngine, captionsSupported, getRecognizerCtor, type CaptionState } from './captions';

export const captionLang = (pref: string): string => pref || (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US';

/** Runs the recognizer while I am in a call, unmuted, with captions switched on. Stops (and releases the mic) otherwise. */
export function useLiveCaptions(deps: { ctor?: ReturnType<typeof getRecognizerCtor> } = {}) {
  const snap = useVoiceSnapshot();
  const on = useUI((s) => s.prefs.captions); const lang = useUI((s) => s.prefs.captionsLang);
  const me = useData((s) => s.me);
  const active = on && snap.status === 'connected' && !snap.muted && !snap.deafened;
  const speaker = me ? displayName(me) : t('You');
  useEffect(() => {
    const st = useCaptions.getState();
    if (!on) { st.setState('off'); st.clear(); return; }
    if (!captionsSupported() && !deps.ctor) { st.setState('unsupported'); return; }
    if (!active) { st.setState('off'); return; }
    const engine = new CaptionEngine({
      ctor: deps.ctor ?? getRecognizerCtor(), lang: captionLang(lang),
      onText: (x) => useCaptions.getState().push({ speaker, ...x }),
      onState: (s: CaptionState) => useCaptions.getState().setState(s),
    });
    engine.start();
    const prune = setInterval(() => useCaptions.getState().prune(), 1000);
    return () => { clearInterval(prune); engine.stop(); };
  }, [on, active, lang, speaker]); // eslint-disable-line
}

/** Caption strip under the tiles. Local only: it shows what MY browser heard me say. */
export function CaptionsOverlay() {
  const on = useUI((s) => s.prefs.captions);
  const lines = useCaptions((s) => s.lines); const state = useCaptions((s) => s.state);
  if (!on) return null;
  const note = state === 'unsupported' ? t('Live captions are not supported by this browser. Try Chrome, Edge or Safari.')
    : state === 'blocked' ? t('Live captions need microphone and speech recognition permission.')
    : state === 'error' ? t('Live captions stopped working. Toggle them off and on to retry.') : null;
  return (
    <div data-testid="captions" data-state={state} className="pointer-events-none mx-auto w-full max-w-3xl shrink-0 px-3 pb-2 text-center">
      <div role="log" aria-live="polite" aria-label={t('Live captions')} className="rounded-lg bg-black/75 px-3 py-2 text-white">
        <p className="mb-1 flex items-center justify-center gap-1 text-[11px] uppercase tracking-wide text-white/60"><CaptionsIcon size={12} aria-hidden />{t('Live captions: your speech only, recognised by your browser')}</p>
        {note ? <p role="status" className="text-sm text-warn">{note}</p>
          : lines.length === 0 ? <p className="text-sm text-white/50">{state === 'listening' ? t('Listening…') : t('Captions appear here while you speak (unmute to start).')}</p>
          : lines.map((l) => <p key={l.id} className={l.final ? 'text-base' : 'text-base italic text-white/80'}><span className="font-semibold">{l.speaker}:</span> {l.text}</p>)}
      </div>
    </div>
  );
}

/** Mount once inside the VoiceProvider. */
export function LiveCaptionsRunner() { useLiveCaptions(); return null; }
