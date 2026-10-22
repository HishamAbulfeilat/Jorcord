import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { LIMITS } from '@jorcord/shared';
import { useAudioUnlock, useDevices, useParticipants, useStreamStats, useVideoTrack, useVoiceClient, useVoiceSnapshot } from './hooks';
import { STREAM_PRESETS, type StreamPresetId, type ViewerQuality, type ContentHint } from '../presets';
import { formatKbps, qualityBars, type NetworkQuality } from '../network';
import type { InputMode, ParticipantView } from '../client';

const cx = (...a: Array<string | false | undefined | null>) => a.filter(Boolean).join(' ');

export function NetworkIndicator({ quality, className }: { quality: NetworkQuality; className?: string }) {
  const bars = qualityBars(quality);
  return (
    <span className={cx('jv-net', `jv-net--${quality}`, className)} role="img" aria-label={`Connection ${quality}`} title={`Connection: ${quality}`}>
      {[1, 2, 3].map((i) => <i key={i} className={cx('jv-net__bar', i <= bars && 'is-on')} />)}
    </span>
  );
}

export function AudioUnlockBanner({ children = 'Click to enable audio' }: { children?: ReactNode }) {
  const { blocked, unlock } = useAudioUnlock();
  if (!blocked) return null;
  return <button type="button" className="jv-unlock" onClick={unlock}>{children}</button>;
}

export function ErrorBanner() {
  const { error } = useVoiceSnapshot();
  const client = useVoiceClient();
  if (!error) return null;
  return (
    <div className="jv-error" role="alert" data-code={error.code}>
      <span>{error.message}</span>
      <button type="button" className="jv-btn jv-btn--ghost" onClick={() => client.clearError()}>Dismiss</button>
    </div>
  );
}

export interface VoiceControlsProps {
  className?: string;
  showCamera?: boolean; showScreen?: boolean; showSettings?: boolean;
  onLeave?: () => void;
  /** Headless: render your own UI. Receives state + actions. */
  children?: (api: VoiceControlsApi) => ReactNode;
}
export interface VoiceControlsApi {
  muted: boolean; deafened: boolean; cameraOn: boolean; screenOn: boolean; pttActive: boolean; status: string; networkQuality: NetworkQuality;
  toggleMute(): void; toggleDeafen(): void; toggleCamera(): void; toggleScreen(): void; leave(): void; canScreenShare: boolean;
}

export function VoiceControls({ className, showCamera = true, showScreen = true, onLeave, children }: VoiceControlsProps) {
  const client = useVoiceClient();
  const s = useVoiceSnapshot();
  const api: VoiceControlsApi = {
    muted: s.muted, deafened: s.deafened, cameraOn: s.cameraOn, screenOn: s.screenOn, pttActive: s.pttActive, status: s.status,
    networkQuality: s.networkQuality, canScreenShare: s.platform.canScreenShare,
    toggleMute: () => void client.toggleMute().catch((e) => client.reportError(e)),
    toggleDeafen: () => void client.toggleDeafen(),
    toggleCamera: () => void client.setCamera(!s.cameraOn).catch(() => {}),
    toggleScreen: () => void (s.screenOn ? client.stopScreenShare() : client.startScreenShare()).catch(() => {}),
    leave: () => { void client.disconnect(); onLeave?.(); },
  };
  if (children) return <>{children(api)}</>;
  return (
    <div className={cx('jv-controls', className)} role="toolbar" aria-label="Voice controls">
      <span className={cx('jv-status', `jv-status--${s.status}`)}>
        <NetworkIndicator quality={s.networkQuality} /> {s.status === 'connected' ? 'Voice connected' : s.status}
      </span>
      <button type="button" className={cx('jv-btn', api.muted && 'is-active')} aria-pressed={api.muted} onClick={api.toggleMute}>{api.muted ? 'Unmute' : 'Mute'}</button>
      <button type="button" className={cx('jv-btn', api.deafened && 'is-active')} aria-pressed={api.deafened} onClick={api.toggleDeafen}>{api.deafened ? 'Undeafen' : 'Deafen'}</button>
      {showCamera && <button type="button" className={cx('jv-btn', api.cameraOn && 'is-active')} aria-pressed={api.cameraOn} onClick={api.toggleCamera}>{api.cameraOn ? 'Stop camera' : 'Camera'}</button>}
      {showScreen && api.canScreenShare && <button type="button" className={cx('jv-btn', api.screenOn && 'is-active')} aria-pressed={api.screenOn} onClick={api.toggleScreen}>{api.screenOn ? 'Stop sharing' : 'Share screen'}</button>}
      <button type="button" className="jv-btn jv-btn--danger" onClick={api.leave}>Leave</button>
    </div>
  );
}

export function StatsOverlay({ identity, source, className }: { identity: string; source: 'camera' | 'screen'; className?: string }) {
  const st = useStreamStats(identity, source, true);
  if (!st) return <div className={cx('jv-stats', className)}>No data</div>;
  return (
    <dl className={cx('jv-stats', className)} aria-label="Stream statistics">
      <div><dt>Resolution</dt><dd>{st.width}x{st.height}</dd></div>
      <div><dt>FPS</dt><dd>{st.fps}</dd></div>
      <div><dt>Bitrate</dt><dd>{formatKbps(st.bitrateKbps)}</dd></div>
      <div><dt>Codec</dt><dd>{st.codec || '-'}</dd></div>
      <div><dt>RTT</dt><dd>{st.rttMs == null ? '-' : `${st.rttMs} ms`}</dd></div>
      {st.qualityLimitation && <div><dt>Limited by</dt><dd>{st.qualityLimitation}</dd></div>}
    </dl>
  );
}

export function StreamQualityMenu({ value, onChange, hint, onHintChange, disabledAbove }: {
  value: StreamPresetId; onChange(v: StreamPresetId): void;
  hint?: ContentHint; onHintChange?(h: ContentHint): void; disabledAbove?: number;
}) {
  return (
    <div className="jv-quality">
      <label className="jv-field">Quality
        <select className="jv-select" value={value} onChange={(e) => onChange(e.target.value as StreamPresetId)}>
          {STREAM_PRESETS.map((p) => (
            <option key={p.id} value={p.id} disabled={!!disabledAbove && p.height > disabledAbove}>
              {p.id === 'source' ? `Source (up to ${LIMITS.stream.maxWidth}x${LIMITS.stream.maxHeight}@${LIMITS.stream.maxFps})` : p.label}
            </option>
          ))}
        </select>
      </label>
      {hint && onHintChange && (
        <label className="jv-field">Optimise for
          <select className="jv-select" value={hint} onChange={(e) => onHintChange(e.target.value as ContentHint)}>
            <option value="motion">Motion (games, video)</option>
            <option value="detail">Detail (text, slides)</option>
          </select>
        </label>
      )}
    </div>
  );
}

export interface VideoTileProps {
  identity: string; source?: 'camera' | 'screen'; className?: string; style?: CSSProperties;
  showName?: boolean; showStats?: boolean; fit?: 'cover' | 'contain'; fallback?: ReactNode;
}
export function VideoTile({ identity, source = 'camera', className, style, showName = true, showStats = false, fit, fallback }: VideoTileProps) {
  const { ref, present, participant } = useVideoTrack(identity, source);
  const objectFit = fit ?? (source === 'screen' ? 'contain' : 'cover');
  return (
    <div className={cx('jv-tile', participant?.speaking && 'is-speaking', participant?.micMuted && 'is-muted', className)} style={style} data-identity={identity}>
      {present
        ? <video ref={ref} className="jv-tile__video" autoPlay playsInline muted style={{ objectFit, transform: participant?.isLocal && source === 'camera' ? 'scaleX(-1)' : undefined }} />
        : <div className="jv-tile__fallback">{fallback ?? <span className="jv-avatar">{(participant?.name ?? '?').slice(0, 1).toUpperCase()}</span>}</div>}
      {showName && <span className="jv-tile__name">{participant?.name ?? identity}{participant?.micMuted ? ' (muted)' : ''}</span>}
      {showStats && present && <StatsOverlay identity={identity} source={source} />}
    </div>
  );
}

export function ScreenShareView({ identity, className, allowQualityChoice = true }: { identity: string; className?: string; allowQualityChoice?: boolean }) {
  const client = useVoiceClient();
  const snap = useVoiceSnapshot();
  const p = snap.participants.find((x) => x.identity === identity);
  const [q, setQ] = useState<ViewerQuality>('auto');
  const [stats, setStats] = useState(false);
  const [watching, setWatching] = useState(true);
  const isMe = !!p?.isLocal;
  useEffect(() => { if (!isMe) client.setViewerQuality(identity, 'screen', q); }, [client, identity, q, isMe, p?.screenOn]);
  if (!p?.screenOn) return null;
  return (
    <section className={cx('jv-screen', className)} aria-label={`${p.name}'s screen`}>
      {watching ? <VideoTile identity={identity} source="screen" showStats={stats} /> : (
        <div className="jv-tile jv-tile__fallback"><button type="button" className="jv-btn" onClick={() => { setWatching(true); client.setWatching(identity, 'screen', true); }}>Watch stream</button></div>
      )}
      <div className="jv-screen__bar">
        {!isMe && allowQualityChoice && (
          <label className="jv-field">Viewing quality
            <select className="jv-select" value={q} onChange={(e) => setQ(e.target.value as ViewerQuality)}>
              <option value="auto">Auto</option><option value="low">360p</option><option value="medium">720p</option><option value="high">Source</option>
            </select>
          </label>
        )}
        {isMe && (
          <StreamQualityMenu value={snap.settings.screenPreset} hint={snap.settings.screenHint}
            onChange={(v) => void client.setLiveStreamQuality(v)} onHintChange={(h) => { client.setContentHint(h); }} />
        )}
        <button type="button" className={cx('jv-btn', stats && 'is-active')} onClick={() => setStats((s) => !s)}>Stats</button>
        {!isMe && <button type="button" className="jv-btn" onClick={() => { setWatching(false); client.setWatching(identity, 'screen', false); }}>Stop watching</button>}
      </div>
    </section>
  );
}

export function ParticipantList({ className, renderItem }: { className?: string; renderItem?: (p: ParticipantView) => ReactNode }) {
  const list = useParticipants();
  const client = useVoiceClient();
  return (
    <ul className={cx('jv-participants', className)}>
      {list.map((p) => (
        <li key={p.identity} className={cx('jv-participant', p.speaking && 'is-speaking', p.micMuted && 'is-muted')}>
          {renderItem ? renderItem(p) : (
            <>
              <span className="jv-avatar">{p.name.slice(0, 1).toUpperCase()}</span>
              <span className="jv-participant__name">{p.name}{p.priority ? ' (priority)' : ''}</span>
              <NetworkIndicator quality={p.quality} />
              {!p.isLocal && (
                <input className="jv-range" type="range" min={0} max={200} value={Math.round(p.volume * 100)} aria-label={`Volume for ${p.name}`}
                  onChange={(e) => client.setUserVolume(p.identity, Number(e.target.value) / 100)} />
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface StageViewProps {
  className?: string;
  /** Moderator action: promote a hand-raiser to speaker (server call; supply from your app). */
  onPromote?: (identity: string) => void | Promise<void>;
  onDemote?: (identity: string) => void | Promise<void>;
  canModerate?: boolean;
  maxAudiencePreview?: number;
}
export function StageView({ className, onPromote, onDemote, canModerate, maxAudiencePreview = 50 }: StageViewProps) {
  const list = useParticipants({ sort: false });
  const client = useVoiceClient();
  const me = list.find((p) => p.isLocal);
  const speakers = list.filter((p) => p.canPublish);
  const audience = list.filter((p) => !p.canPublish);
  const hands = audience.filter((p) => p.handRaised);
  const rest = audience.filter((p) => !p.handRaised);
  return (
    <div className={cx('jv-stage', className)}>
      <section aria-label="Speakers" className="jv-stage__speakers">
        <h3 className="jv-stage__title">Speakers ({speakers.length})</h3>
        <div className="jv-grid">
          {speakers.map((p) => (
            <div key={p.identity} className="jv-stage__speaker">
              <VideoTile identity={p.identity} source="camera" />
              {canModerate && !p.isLocal && onDemote && <button type="button" className="jv-btn jv-btn--ghost" onClick={() => void onDemote(p.identity)}>Move to audience</button>}
            </div>
          ))}
        </div>
      </section>
      {hands.length > 0 && (
        <section aria-label="Requests to speak" className="jv-stage__hands">
          <h3 className="jv-stage__title">Requests to speak ({hands.length})</h3>
          <ul className="jv-participants">
            {hands.map((p) => (
              <li key={p.identity} className="jv-participant"><span className="jv-avatar">{p.name.slice(0, 1).toUpperCase()}</span><span className="jv-participant__name">{p.name}</span>
                {canModerate && onPromote && <button type="button" className="jv-btn" onClick={() => void onPromote(p.identity)}>Invite to speak</button>}</li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Audience" className="jv-stage__audience">
        <h3 className="jv-stage__title">Audience ({audience.length})</h3>
        <ul className="jv-participants jv-participants--compact">
          {rest.slice(0, maxAudiencePreview).map((p) => <li key={p.identity} className="jv-participant"><span className="jv-avatar">{p.name.slice(0, 1).toUpperCase()}</span><span className="jv-participant__name">{p.name}</span></li>)}
          {rest.length > maxAudiencePreview && <li className="jv-participant">+{rest.length - maxAudiencePreview} more</li>}
        </ul>
      </section>
      {me && !me.canPublish && (
        <button type="button" className={cx('jv-btn', me.handRaised && 'is-active')} onClick={() => void client.setHandRaised(!me.handRaised)}>
          {me.handRaised ? 'Lower hand' : 'Request to speak'}
        </button>
      )}
    </div>
  );
}

export function VoiceSettingsPanel({ className }: { className?: string }) {
  const client = useVoiceClient();
  const { audioinput, audiooutput, videoinput, settings } = useDevices();
  const a = settings.audio;
  const supportsSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const label = (d: MediaDeviceInfo, i: number) => d.label || `Device ${i + 1}`;
  const tg = (key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl' | 'dtx' | 'red' | 'musicMode', text: string) => (
    <label className="jv-check"><input type="checkbox" checked={a[key]} onChange={(e) => void client.setAudioSettings({ [key]: e.target.checked })} /> {text}</label>
  );
  return (
    <form className={cx('jv-settings', className)} onSubmit={(e) => e.preventDefault()}>
      <label className="jv-field">Microphone
        <select className="jv-select" value={a.inputDeviceId ?? ''} onChange={(e) => void client.setInputDevice(e.target.value)}>
          <option value="">Default</option>{audioinput.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
        </select>
      </label>
      {supportsSink && (
        <label className="jv-field">Speakers
          <select className="jv-select" value={a.outputDeviceId ?? ''} onChange={(e) => void client.setOutputDevice(e.target.value)}>
            <option value="">Default</option>{audiooutput.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
        </label>
      )}
      <label className="jv-field">Camera
        <select className="jv-select" onChange={(e) => void client.setCameraDevice(e.target.value)}>
          {videoinput.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
        </select>
      </label>
      <label className="jv-field">Input mode
        <select className="jv-select" value={settings.inputMode} onChange={(e) => client.setInputMode(e.target.value as InputMode)}>
          <option value="open">Voice open</option><option value="vad">Voice activity</option><option value="ptt">Push to talk</option>
        </select>
      </label>
      {settings.inputMode === 'ptt' && <PttKeyPicker />}
      {settings.inputMode === 'vad' && (
        <label className="jv-field">Sensitivity threshold
          <input className="jv-range" type="range" min={5} max={200} value={Math.round(settings.vadThreshold * 1000)}
            onChange={(e) => client.setVadThreshold(Number(e.target.value) / 1000)} />
        </label>
      )}
      {tg('echoCancellation', 'Echo cancellation')}
      {tg('noiseSuppression', 'Noise suppression (browser)')}
      <label className="jv-field">Noise suppression engine
        <select className="jv-select" value={a.noiseSuppressionMode} onChange={(e) => void client.setAudioSettings({ noiseSuppressionMode: e.target.value as any })}>
          <option value="off">Off</option><option value="browser">Browser built-in</option><option value="rnnoise">Standard (RNNoise)</option><option value="high">High (RNNoise + browser)</option>
        </select>
      </label>
      {tg('autoGainControl', 'Automatic gain control')}
      {tg('dtx', 'DTX (save bandwidth in silence)')}
      {tg('red', 'RED (packet-loss resilience)')}
      {tg('musicMode', 'Music mode (stereo, no processing)')}
      <label className="jv-field">Opus bitrate: {a.bitrateKbps} kbps
        <input className="jv-range" type="range" min={16} max={LIMITS.audio.bitrateKbps} step={2} value={a.bitrateKbps}
          onChange={(e) => void client.setAudioSettings({ bitrateKbps: Number(e.target.value) })} />
      </label>
    </form>
  );
}

function PttKeyPicker() {
  const client = useVoiceClient();
  const { settings } = useVoiceSnapshot();
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => { e.preventDefault(); client.setPttKey(e.code); setRec(false); };
    window.addEventListener('keydown', h, { once: true });
    return () => window.removeEventListener('keydown', h);
  }, [rec, client]);
  return <button type="button" className="jv-btn" onClick={() => setRec(true)}>{rec ? 'Press a key...' : `PTT key: ${settings.pttCode}`}</button>;
}
