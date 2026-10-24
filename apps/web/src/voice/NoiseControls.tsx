import { useEffect, useRef, useState } from 'react';
import { NOISE_STRENGTHS, applyNoiseStrength, buildNoiseGraph, openNoiseContext, resolveNoiseTuning, NOISE_WORKLET_NAME, type NoiseGraph, type NoiseStrength } from '@jorcord/voice';
import { useUI } from '@/stores/ui';
import { t } from '@/i18n';
import './noiseSetup';

const LABEL: Record<NoiseStrength, string> = { off: 'Off', light: 'Light', standard: 'Standard', strong: 'Strong' };
const DESC: Record<NoiseStrength, string> = {
  off: 'No suppression: your voice is sent as captured.',
  light: 'Gentle: keeps your voice natural and removes steady noise (fans, hum).',
  standard: 'Balanced: removes most background noise with a soft gate that never cuts word endings.',
  strong: 'Maximum: fully denoised plus the browser filter. Best for loud rooms; can sound slightly processed.',
};

/** Listen-to-yourself A/B: the same live mic through the real noise pipeline (B) versus untouched (A). Use headphones. */
function ABTest() {
  const p = useUI((s) => s.prefs);
  const [on, setOn] = useState(false); const [side, setSide] = useState<'raw' | 'processed'>('processed'); const [err, setErr] = useState('');
  const h = useRef<{ stop(): void; set(s: 'raw' | 'processed'): void; tune(t: ReturnType<typeof resolveNoiseTuning>): void } | null>(null);
  useEffect(() => () => h.current?.stop(), []);
  useEffect(() => { h.current?.set(side); }, [side]);
  useEffect(() => { h.current?.tune(resolveNoiseTuning(p.noiseStrength, p.noiseMix)); }, [p.noiseStrength, p.noiseMix]);
  const toggle = async () => {
    if (on) { h.current?.stop(); h.current = null; setOn(false); return; }
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: p.inputDevice === 'default' ? undefined : { exact: p.inputDevice }, echoCancellation: p.echoCancellation, noiseSuppression: p.noiseEngine === 'browser' || p.noiseEngine === 'high', autoGainControl: p.autoGain } });
      const opened = await openNoiseContext();
      if ('reason' in opened) { stream.getTracks().forEach((x) => x.stop()); setErr(t('Advanced noise suppression is not available here; the browser filter is used in calls.')); return; }
      const { ctx, Worklet } = opened as { ctx: AudioContext; Worklet: any };
      const track = stream.getAudioTracks()[0]!;
      const rawGain = ctx.createGain(); const procGain = ctx.createGain();
      ctx.createMediaStreamSource(new MediaStream([track])).connect(rawGain); rawGain.connect(ctx.destination);
      procGain.connect(ctx.destination);
      const g: NoiseGraph = buildNoiseGraph(ctx, Worklet, NOISE_WORKLET_NAME, track, resolveNoiseTuning(p.noiseStrength, p.noiseMix), {}, {}, procGain);
      const set = (s: 'raw' | 'processed') => { const now = ctx.currentTime; rawGain.gain.setTargetAtTime(s === 'raw' ? 1 : 0, now, 0.02); procGain.gain.setTargetAtTime(s === 'raw' ? 0 : 1, now, 0.02); };
      set(side);
      h.current = { set, tune: (tn) => g.setTuning(tn), stop: () => { g.dispose(); stream.getTracks().forEach((x) => x.stop()); void ctx.close(); } };
      setOn(true);
    } catch { setErr(t('Microphone access was denied or no microphone was found.')); }
  };
  return (
    <div className="mb-4 rounded-lg bg-side p-3" data-testid="noise-ab">
      <div className="flex items-center justify-between gap-3"><span className="font-semibold text-header">{t('Listen to yourself')}</span><button className="btn btn-secondary" onClick={() => void toggle()}>{on ? t('Stop') : t('Start')}</button></div>
      <p className="mt-1 text-sm text-muted">{t('Switch between your original voice and the processed one while you talk. Use headphones to avoid feedback.')}</p>
      {on && <div role="radiogroup" aria-label={t('Compare')} className="mt-2 flex gap-2">
        {(['raw', 'processed'] as const).map((s) => <button key={s} role="radio" aria-checked={side === s} className={`btn ${side === s ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setSide(s)}>{s === 'raw' ? t('A: Original') : t('B: Processed')}</button>)}
      </div>}
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}

/** Strength (Off/Light/Standard/Strong), wet/dry mix and the A/B listen test for the noise suppression setting. */
export function NoiseControls() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  const strength = !p.noiseSuppression ? 'off' : p.noiseStrength;
  const wet = p.noiseMix ?? resolveNoiseTuning(strength).wet;
  const pick = (s: NoiseStrength) => { const a = applyNoiseStrength(s); set('noiseSuppression', a.noiseSuppression); set('noiseEngine', a.noiseSuppressionMode); set('noiseStrength', s); set('noiseMix', null); };
  return (
    <div data-testid="noise-controls" className="mb-4">
      <span className="label">{t('Noise suppression strength')}</span>
      <div role="radiogroup" aria-label={t('Noise suppression strength')} className="mb-1 grid grid-cols-4 gap-2">
        {NOISE_STRENGTHS.map((s) => <button key={s} role="radio" aria-checked={strength === s} className={`btn ${strength === s ? 'btn-primary' : 'btn-secondary'}`} onClick={() => pick(s)}>{t(LABEL[s])}</button>)}
      </div>
      <p className="text-sm text-muted">{t(DESC[strength])}</p>
      {strength !== 'off' && !p.musicMode && (
        <label className="mt-2 block"><span className="label">{t('Original voice')} ↔ {t('Denoised')} — {Math.round(wet * 100)}%</span>
          <input type="range" aria-label={t('Wet/dry mix')} min={0} max={100} value={Math.round(wet * 100)} onChange={(e) => set('noiseMix', Number(e.target.value) / 100)} className="w-full accent-brand" />
          <span className="text-xs text-muted">{t('If your voice sounds robotic, move this toward the original voice.')}</span></label>)}
      <div className="mt-3"><ABTest /></div>
    </div>
  );
}
