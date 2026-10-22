import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CAMERA_FRAME_RATES, STREAM_PRESETS, cameraPlan, type CameraFrameRate, type CameraQuality } from '@jorcord/voice';
import { LIMITS } from '@jorcord/shared';
import { Toggle, Row, Modal } from '@/components/ui/primitives';
import { useUI, type Prefs } from '@/stores/ui';
import { noiseStatusText } from './noiseStatus';
import { captionsSupported } from './captions';
import { t } from '@/i18n';
import { getVoiceClient } from './controller';
import { cx } from '@/lib/format';
import { SelfViewVideo } from './tiles';
import { isCanvasFilterSupported } from './cameraEffects';
import { isTauri } from '@/lib/server';

function NoiseStatus({ mode, musicMode }: { mode: Prefs['noiseEngine']; musicMode: boolean }) {
  const c = getVoiceClient();
  const fallback = useSyncExternalStore(c.subscribe, () => c.getSnapshot().noise.fallback);
  const st = noiseStatusText(mode, { musicMode, fallback });
  return <p className={cx('mt-1 text-sm', st.tone === 'warn' ? 'text-warn' : 'text-muted')} role={st.tone === 'warn' ? 'status' : undefined} data-testid="noise-status">{st.text}</p>;
}

const CAPTION_LANGS: [string, string][] = [['', 'Browser language'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['tr-TR', 'Türkçe'], ['ar-SA', 'العربية']];
function CaptionSettings() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref); const supported = captionsSupported();
  return (
    <>
      <Row title={t('Show live captions')} desc={t('Captions of your own speech, shown to you only, using your browser’s speech recognition. Chrome and Edge may send your microphone audio to their speech service; Jorcord never receives it. It listens only while you are in a call and unmuted.')}>
        <Toggle label={t('Show live captions')} checked={p.captions && supported} disabled={!supported} onChange={(v) => set('captions', v)} />
      </Row>
      {!supported && <p role="status" data-testid="captions-unsupported" className="mb-3 text-sm text-muted">{t('Live captions are not supported by this browser. Try Chrome, Edge or Safari.')}</p>}
      {supported && p.captions && (
        <Field label={t('Caption language')}>
          <select className="field" aria-label={t('Caption language')} value={p.captionsLang} onChange={(e) => set('captionsLang', e.target.value)}>{CAPTION_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>)}
    </>
  );
}

const H3 = ({ children }: { children: React.ReactNode }) => <h3 className="section-title mb-2 mt-5">{children}</h3>;
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="mb-4 block"><span className="label">{label}</span>{children}</label>;

/**
 * Local camera preview (never published). Requests the same quality ladder as the call and falls back
 * 1080p -> 720p -> 480p, so what you see here matches what the call will send.
 */
function CameraPreview({ deviceId, quality, fps }: { deviceId: string; quality: CameraQuality; fps: CameraFrameRate }) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setErr('Camera preview is not available on this device.'); setOn(false); return; }
      setErr('');
      for (const a of cameraPlan(quality, fps).attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              ...(deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
              width: { ideal: a.width }, height: { ideal: a.height }, frameRate: { ideal: a.fps },
            },
          });
          break;
        } catch { /* try the next lower resolution */ }
      }
      if (cancelled) { stream?.getTracks().forEach((t) => t.stop()); return; }
      if (!stream) { setErr('Could not start the camera preview.'); setOn(false); return; }
      if (video.current) { video.current.srcObject = stream; void video.current.play?.().catch(() => {}); }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [on, deviceId, quality, fps]);
  return (
    <div className="mb-4 rounded-lg bg-side p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-semibold text-header">Camera Preview</span>
        <button type="button" className="btn btn-secondary" onClick={() => { setErr(''); setOn((v) => !v); }}>{on ? 'Stop Preview' : 'Preview Camera'}</button>
      </div>
      <div className="relative aspect-video overflow-hidden rounded bg-black">
        {on
          ? <SelfViewVideo videoRef={video} label="Camera preview" testId="camera-preview" className="h-full w-full object-cover" />
          : <div className="flex h-full items-center justify-center text-sm text-muted">Preview your camera and framing.</div>}
      </div>
      {err && <p className="mt-2 text-sm text-danger" role="alert">{err}</p>}
    </div>
  );
}

/** Voice & Video settings: devices, input mode, noise suppression, bitrate, stream defaults, mic test. */
export function VoiceSettingsForm({ compact }: { compact?: boolean }) {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]); const [err, setErr] = useState('');
  const [level, setLevel] = useState(0); const stop = useRef<() => void>();
  const [testing, setTesting] = useState(false);
  const [rec, setRec] = useState(false);
  const load = () => navigator.mediaDevices?.enumerateDevices().then(setDevs).catch(() => {});
  useEffect(() => { void load(); navigator.mediaDevices?.addEventListener?.('devicechange', load); return () => { stop.current?.(); navigator.mediaDevices?.removeEventListener?.('devicechange', load); }; }, []);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); if (e.code !== 'Escape') set('pttCode', e.code); setRec(false); };
    window.addEventListener('keydown', h, { once: true, capture: true });
    return () => window.removeEventListener('keydown', h, true);
  }, [rec, set]);
  const unlabeled = devs.some((d) => d.kind === 'audioinput' && !d.label);
  const test = async () => {
    if (testing) { stop.current?.(); setTesting(false); return; }
    try {
      setErr('');
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: p.inputDevice === 'default' ? undefined : { exact: p.inputDevice }, echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGain } });
      await load();
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(an); const buf = new Uint8Array(an.fftSize); let raf = 0;
      const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const b of buf) m = Math.max(m, Math.abs(b - 128)); setLevel(m / 128); raf = requestAnimationFrame(tick); }; tick();
      stop.current = () => { cancelAnimationFrame(raf); s.getTracks().forEach((t) => t.stop()); void ctx.close(); setLevel(0); };
      setTesting(true);
    } catch { setErr('Microphone access was denied or no microphone was found.'); }
  };
  const sel = (kind: MediaDeviceKind, key: 'inputDevice' | 'outputDevice' | 'videoDevice', label: string) => (
    <Field label={label}>
      <select className="field" aria-label={label} value={p[key]} onChange={(e) => set(key, e.target.value)}>
        <option value="default">Default</option>
        {devs.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${kind === 'audioinput' ? 'Microphone' : kind === 'audiooutput' ? 'Speaker' : 'Camera'} ${i + 1}`}</option>)}
      </select>
    </Field>);
  const mode = p.pushToTalk ? 'ptt' : p.vadMode ? 'vad' : 'open';
  const setMode = (m: string) => { set('pushToTalk', m === 'ptt'); set('vadMode', m === 'vad'); };
  const supportsSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const blurSupported = isCanvasFilterSupported();
  return (
    <div data-testid="voice-settings">
      <div className={cx('grid gap-x-6', !compact && 'sm:grid-cols-2')}>{sel('audioinput', 'inputDevice', 'Input Device')}{supportsSink && sel('audiooutput', 'outputDevice', 'Output Device')}</div>
      {unlabeled && <p className="-mt-2 mb-4 text-sm text-muted">Device names appear after you allow microphone access. Use “Let’s Check” below.</p>}
      <div className="mb-4 rounded-lg bg-side p-3">
        <div className="mb-2 flex items-center justify-between gap-3"><span className="font-semibold text-header">Mic Test</span><button className="btn btn-secondary" onClick={test}>{testing ? 'Stop Testing' : 'Let’s Check'}</button></div>
        <div className="h-2 overflow-hidden rounded bg-rail" role="meter" aria-label="Input level" aria-valuenow={Math.round(level * 100)}><div className="h-full bg-success transition-[width]" style={{ width: `${Math.min(100, level * 160)}%` }} /></div>
        {err && <p className="mt-2 text-sm text-danger" role="alert">{err}</p>}
      </div>
      {sel('videoinput', 'videoDevice', 'Camera')}

      <H3>Input mode</H3>
      <div role="radiogroup" aria-label="Input mode" className="mb-2 grid gap-2">
        {([['open', 'Always transmit', 'Your microphone is always live while unmuted.'], ['vad', 'Voice Activity', 'Only transmit when you speak.'], ['ptt', 'Push to Talk', 'Hold a key to transmit.']] as const).map(([v, l, d]) => (
          <label key={v} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border-2 p-3', mode === v ? 'border-brand' : 'border-divider')}>
            <input type="radio" className="accent-brand" name="inputmode" checked={mode === v} onChange={() => setMode(v)} aria-label={l} /><span><span className="block font-medium text-header">{l}</span><span className="block text-sm text-muted">{d}</span></span>
          </label>))}
      </div>
      {mode === 'ptt' && isTauri() && <Row title="Global shortcut" desc="Keep push-to-talk working while Jorcord is in the background, for example in a game. The key is captured system-wide, so other apps will not receive it."><Toggle label="Global push-to-talk" checked={p.pttGlobal} onChange={(v) => set('pttGlobal', v)} /></Row>}
      {mode === 'ptt' && <Row title="Shortcut" desc="Hold this key to talk (works while Jorcord is focused)."><button className={cx('min-w-[110px] rounded bg-rail px-3 py-1.5 font-mono text-sm', rec ? 'text-danger ring-2 ring-danger' : 'text-header')} onClick={() => setRec(true)}>{rec ? 'Press a key…' : p.pttCode}</button></Row>}
      {mode === 'vad' && <Field label="Input sensitivity"><input type="range" aria-label="Input sensitivity" min={5} max={200} value={Math.round(p.vadThreshold * 1000)} onChange={(e) => set('vadThreshold', Number(e.target.value) / 1000)} className="w-full accent-brand" /></Field>}

      <H3>Audio processing</H3>
      <Field label="Noise suppression">
        <select className="field" aria-label="Noise suppression" value={!p.noiseSuppression ? 'off' : p.noiseEngine} onChange={(e) => { const v = e.target.value as Prefs['noiseEngine']; set('noiseSuppression', v !== 'off'); set('noiseEngine', v); }}>
          <option value="off">Off</option><option value="browser">Browser built-in</option><option value="rnnoise">Standard (RNNoise)</option><option value="high">High (RNNoise + browser)</option>
        </select>
        <NoiseStatus mode={!p.noiseSuppression ? 'off' : p.noiseEngine} musicMode={p.musicMode} />
      </Field>
      <Row title="Echo Cancellation"><Toggle label="Echo cancellation" checked={p.echoCancellation} onChange={(v) => set('echoCancellation', v)} /></Row>
      <Row title="Automatic Gain Control"><Toggle label="Automatic gain control" checked={p.autoGain} onChange={(v) => set('autoGain', v)} /></Row>
      <Row title="Music Mode" desc="Stereo, no processing, higher bitrate."><Toggle label="Music mode" checked={p.musicMode} onChange={(v) => set('musicMode', v)} /></Row>
      <Field label={`Voice bitrate — ${p.voiceBitrate} kbps`}><input type="range" aria-label="Voice bitrate" min={8} max={LIMITS.audio.bitrateKbps} step={2} value={p.voiceBitrate} onChange={(e) => set('voiceBitrate', Number(e.target.value))} className="w-full accent-brand" /></Field>

      <Row title={t('Warn me when I speak while muted')} desc={t('Shows “You are muted” when your microphone hears you talking while you are muted. The audio is only measured on this device and never leaves it. Turning this off stops listening to the muted microphone.')}>
        <Toggle label={t('Warn me when I speak while muted')} checked={p.mutedSpeakingHint} onChange={(v) => set('mutedSpeakingHint', v)} />
      </Row>

      <H3>{t('Live captions')}</H3>
      <CaptionSettings />

      <H3>Camera & streaming</H3>
      <div className={cx('grid gap-x-6', !compact && 'sm:grid-cols-2')}>
        <Field label="Video quality"><select className="field" aria-label="Video quality" value={p.videoQuality} onChange={(e) => set('videoQuality', e.target.value as CameraQuality)}>
          <option value="auto">Auto (up to 1080p)</option><option value="720p">720p</option><option value="1080p">1080p</option>
        </select></Field>
        <Field label="Frame rate"><select className="field" aria-label="Frame rate" value={p.videoFps} onChange={(e) => set('videoFps', Number(e.target.value) as CameraFrameRate)}>
          {CAMERA_FRAME_RATES.map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select></Field>
        <Field label="Default stream quality"><select className="field" aria-label="Default stream quality" value={p.screenPreset} onChange={(e) => set('screenPreset', e.target.value as any)}>{STREAM_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.id === 'source' ? 'Source' : x.label}</option>)}</select></Field>
      </div>
      <Row title="Mirror my camera" desc="Flip your own preview only; everyone else still sees the un-mirrored feed."><Toggle label="Mirror my camera" checked={p.mirrorSelfView} onChange={(v) => set('mirrorSelfView', v)} /></Row>
      <Row title="Background blur" desc={blurSupported ? 'Soft-focus blur of your preview (softens the whole frame — no person cut-out). Runs locally and pauses in background tabs.' : 'This browser cannot apply canvas filters, so blur is unavailable.'}>
        <Toggle label="Background blur" checked={p.cameraBlur} disabled={!blurSupported} onChange={(v) => set('cameraBlur', v)} />
      </Row>
      <Row title="Auto brightness & contrast" desc="Nudges exposure when the frame is too dark or too bright."><Toggle label="Auto brightness and contrast" checked={p.cameraAutoAdjust} onChange={(v) => set('cameraAutoAdjust', v)} /></Row>
      <CameraPreview deviceId={p.videoDevice} quality={p.videoQuality} fps={p.videoFps} />
      <Row title="Show connection stats" desc="Resolution, frame rate, bitrate and codec on video tiles."><Toggle label="Show connection stats" checked={p.showVoiceStats} onChange={(v) => set('showVoiceStats', v)} /></Row>
    </div>
  );
}

export function VoiceSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Voice & Video Settings" onClose={onClose} width={560}>
      <div className="max-h-[70dvh] overflow-y-auto px-1 pb-4 pt-2 text-start"><VoiceSettingsForm compact /></div>
      <div className="flex justify-end p-4 pt-0"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
