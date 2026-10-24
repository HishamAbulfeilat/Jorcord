import { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Loader2, Stethoscope } from 'lucide-react';
import { detectEcho, makeEchoTestSignal, measureMic, suggestFixes, type EchoResult, type MicLevels, type Suggestion } from '@jorcord/voice';
import { Modal } from '@/components/ui/primitives';
import { useUI } from '@/stores/ui';
import { t } from '@/i18n';
import { getVoiceClient } from './controller';
import { cx } from '@/lib/format';

/** Records `ms` of the stream and returns mono samples (decoded locally; nothing is uploaded). */
export async function recordClip(stream: MediaStream, ms: number): Promise<{ samples: Float32Array; sampleRate: number }> {
  const rec = new MediaRecorder(stream); const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(); await new Promise((r) => setTimeout(r, ms)); rec.stop(); await done;
  const ctx = new AudioContext();
  try { const buf = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer()); return { samples: buf.getChannelData(0).slice(), sampleRate: buf.sampleRate }; }
  finally { void ctx.close(); }
}

const micError = (e: any): 'denied' | 'not-found' | 'in-use' | 'other' => (e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'not-found' : e?.name === 'NotReadableError' ? 'in-use' : 'other');
const ICON = { info: <CheckCircle2 size={14} className="text-success" />, warn: <AlertTriangle size={14} className="text-warn" />, fail: <XCircle size={14} className="text-danger" /> };

/** "Audio problem? Run diagnostics": mic level, loopback echo test, record-and-play-back, device check, then plain-language fixes. */
export function AudioWizardModal({ onClose }: { onClose: () => void }) {
  const p = useUI((s) => s.prefs); const setPref = useUI((s) => s.setPref);
  const [step, setStep] = useState<'intro' | 'run' | 'done'>('intro'); const [status, setStatus] = useState('');
  const [out, setOut] = useState<Suggestion[]>([]); const [playback, setPlayback] = useState<string | null>(null);
  const [levels, setLevels] = useState<MicLevels | null>(null);
  const run = async () => {
    setStep('run'); setPlayback(null);
    let micErr: ReturnType<typeof micError> | null = null; let lv: MicLevels | null = null; let echo: EchoResult | null = null;
    const dev = p.inputDevice === 'default' ? undefined : { exact: p.inputDevice };
    let devices: MediaDeviceInfo[] = [];
    try {
      setStatus(t('Stay quiet for a second, then count from one to five…'));
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev, echoCancellation: p.echoCancellation, noiseSuppression: false, autoGainControl: p.autoGain } });
      devices = await navigator.mediaDevices.enumerateDevices();
      const clip = await recordClip(s, 4500); lv = measureMic(clip.samples, clip.sampleRate); s.getTracks().forEach((x) => x.stop());
      setStatus(t('Playing a test sound to check for echo…'));
      const raw = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new AudioContext(); const sig = makeEchoTestSignal(ctx.sampleRate); const ab = ctx.createBuffer(1, sig.length, ctx.sampleRate); ab.copyToChannel(sig as any, 0);
      const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
      const recording = recordClip(raw, Math.round((sig.length / ctx.sampleRate) * 1000) + 900); src.start();
      const r = await recording; raw.getTracks().forEach((x) => x.stop()); void ctx.close();
      echo = detectEcho(sig.length ? resample(sig, ctx.sampleRate, r.sampleRate) : sig, r.samples, r.sampleRate);
      setStatus(t('Recording a short clip to play back…'));
      const s3 = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev, echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGain } });
      const rec = new MediaRecorder(s3); const chunks: Blob[] = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise<void>((res) => { rec.onstop = () => res(); }); rec.start(); await new Promise((r2) => setTimeout(r2, 3000)); rec.stop(); await stopped; s3.getTracks().forEach((x) => x.stop());
      setPlayback(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })));
    } catch (e) { micErr = micError(e); }
    const snap = getVoiceClient().getSnapshot();
    setLevels(lv);
    setOut(suggestFixes({
      micError: micErr, levels: lv, echo, noiseFallback: snap.noise.fallback, connection: snap.connection,
      devices: { inputs: devices.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label })), outputs: devices.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label })), selectedInputId: p.inputDevice },
      settings: { echoCancellation: p.echoCancellation, autoGainControl: p.autoGain, noiseSuppression: p.noiseSuppression, noiseSuppressionMode: p.noiseEngine, noiseStrength: p.noiseStrength, musicMode: p.musicMode },
    }));
    setStep('done');
  };
  const apply = (a: NonNullable<Suggestion['apply']>) => {
    if ('echoCancellation' in a) setPref('echoCancellation', !!a.echoCancellation);
    if ('autoGainControl' in a) setPref('autoGain', !!a.autoGainControl);
    if ('musicMode' in a) setPref('musicMode', !!a.musicMode);
    if (a.noiseStrength) setPref('noiseStrength', a.noiseStrength);
    if ('noiseSuppression' in a) setPref('noiseSuppression', !!a.noiseSuppression);
    if (a.noiseSuppressionMode) setPref('noiseEngine', a.noiseSuppressionMode);
    setOut((o) => o.map((x) => (x.apply === a ? { ...x, apply: undefined, detail: `${x.detail} (${t('Applied')})` } : x)));
  };
  return (
    <Modal title={t('Audio diagnostics')} onClose={onClose} width={520}>
      <div data-testid="audio-wizard" className="px-1 pb-4 pt-2 text-start text-sm">
        {step === 'intro' && <><p className="mb-3 text-muted">{t('Checks your microphone level, whether your speakers leak into the microphone, your devices and your connection, then suggests fixes. Recordings stay on this device. Use speakers (not headphones) for the echo test to be meaningful.')}</p><button className="btn btn-primary" onClick={() => void run()}><Stethoscope size={14} />{t('Start')}</button></>}
        {step === 'run' && <p className="flex items-center gap-2 text-header" role="status"><Loader2 size={14} className="animate-spin" />{status}</p>}
        {step === 'done' && <>
          {levels && <p className="mb-2 font-mono text-xs text-muted">{t('Voice')} {Math.round(levels.speechDb)} dB · {t('background')} {Math.round(levels.noiseFloorDb)} dB</p>}
          {playback && <div className="mb-3"><p className="mb-1 text-muted">{t('This is what others hear (with your current processing):')}</p><audio controls src={playback} className="w-full" /></div>}
          <ul className="grid gap-2">{out.map((s) => (
            <li key={s.id} data-severity={s.severity} className="flex gap-2"><span className="mt-0.5 shrink-0">{ICON[s.severity]}</span>
              <span className="flex-1"><b className="text-header">{s.title}</b> <span className="text-muted">{s.detail}</span>{s.apply && <button className={cx('btn btn-secondary mt-1 block')} onClick={() => apply(s.apply!)}>{t('Fix it')}</button>}</span></li>))}</ul>
          <div className="mt-4 flex gap-2"><button className="btn btn-secondary" onClick={() => void run()}>{t('Run again')}</button><button className="btn btn-primary" onClick={onClose}>{t('Done')}</button></div>
        </>}
      </div>
    </Modal>
  );
}

/** Linear resample of the played test signal to the recording rate so the envelopes line up in time. */
function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from); const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = x[Math.min(x.length - 1, Math.round((i * from) / to))]!;
  return o;
}
