import {
  Room, RoomEvent, Track, VideoPreset, ConnectionState, ParticipantEvent,
  type Participant, type RemoteParticipant, type LocalParticipant, type TrackPublication,
  type RoomOptions, type TrackPublishOptions, type ScreenShareCaptureOptions, type VideoCaptureOptions,
  type LocalVideoTrack, type RemoteVideoTrack, type RemoteTrackPublication, type LocalTrackPublication,
  type VideoCodec, type BaseKeyProvider,
} from 'livekit-client';
import type { VoiceToken } from '@jorcord/shared';
import { DEFAULT_AUDIO, resolveAudio, type AudioSettings } from './audio';
import { mapVoiceError, type VoiceError } from './errors';
import { mapConnectionQuality, type NetworkQuality, type StreamStats } from './network';
import { createRnnoiseProcessor, type NoiseFallbackReason } from './noise';
import { createPushToTalk } from './ptt';
import { effectiveVolume, clampUserVolume } from './priority';
import { AudioBoost } from './boost';
import {
  cameraPlan, detectSupportedVideoCodecs, isScalableCodec, normalizeCameraFps, pickCodec, recommendBitrateKbps, selectPreset, simulcastLayers,
  viewerQualityToDimensions, type CameraEncoding, type CameraQuality, type ContentHint, type StreamPresetId, type VideoCodecName, type ViewerQuality,
} from './presets';
import { detectPlatform, mobileConstraints, type Platform } from './mobile';
import { initialSpeaking, speakingReducer, type SpeakingState } from './speaking';
import { parseVideoStats, parseConnectionStats, type StatsSample, type ConnectionStats, type ConnSample } from './stats';
import {
  backoffDelay, initialReconnect, lossReasonOf, reconnectReducer, statusOf,
  type BackoffOptions, type LossReason, type ReconnectEvent, type ReconnectPhase, type ReconnectState, DEFAULT_BACKOFF,
} from './reconnect';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type InputMode = 'open' | 'vad' | 'ptt';
export type StreamSource = 'camera' | 'screen';

export interface ParticipantView {
  identity: string; userId: string; name: string; isLocal: boolean;
  speaking: boolean; level: number; micMuted: boolean; cameraOn: boolean; screenOn: boolean; screenAudioOn: boolean;
  quality: NetworkQuality; volume: number; /** Locally muted by this listener (their volume setting is kept). */ localMuted: boolean; priority: boolean; handRaised: boolean;
  /** LiveKit publish permission: stage speaker / allowed to talk. */
  canPublish: boolean; metadata: string | undefined;
}

export interface VoiceSettings {
  audio: AudioSettings;
  inputMode: InputMode;
  pttCode: string;
  pttReleaseMs: number;
  vadThreshold: number;
  cameraPreset: StreamPresetId;
  /** Camera capture quality: auto starts at 1080p and falls back to 720p/480p. */
  cameraQuality: CameraQuality;
  /** Requested camera frame rate (15/24/30/60). */
  cameraFps: number;
  screenPreset: StreamPresetId;
  screenHint: Exclude<ContentHint, 'text'> | 'text';
  screenAudio: boolean;
  codec: VideoCodecName | 'auto';
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  audio: DEFAULT_AUDIO, inputMode: 'open', pttCode: 'Backquote', pttReleaseMs: 200, vadThreshold: 0.03,
  cameraPreset: '720p30', cameraQuality: 'auto', cameraFps: 30,
  screenPreset: '1080p60', screenHint: 'motion', screenAudio: true, codec: 'auto',
};

export interface VoiceSnapshot {
  status: VoiceStatus; error: VoiceError | null; channelId: string | null;
  participants: ParticipantView[]; speaking: SpeakingState;
  muted: boolean; deafened: boolean; cameraOn: boolean; screenOn: boolean; pttActive: boolean;
  networkQuality: NetworkQuality; audioBlocked: boolean; e2ee: boolean; platform: Platform;
  devices: { audioinput: MediaDeviceInfo[]; audiooutput: MediaDeviceInfo[]; videoinput: MediaDeviceInfo[] };
  settings: VoiceSettings; activeCodec: VideoCodecName | null;
  /** Auto-reconnect progress (phase 'waiting' has `nextRetryAt`). */
  reconnect: { phase: ReconnectPhase; attempt: number; maxAttempts: number; nextRetryAt: number | null; reason: LossReason | null };
  /** Ping / loss / ICE path of the live session (null until the first sample). */
  connection: ConnectionStats | null;
  /** Signalling URL in use and the LiveKit server version, for the diagnostics panel. */
  serverUrl: string | null; serverVersion: string | null;
  /** Camera/screen were on before a drop. The camera is restored automatically; a screen share needs a user gesture. */
  screenResumeNeeded: boolean;
  /** Noise suppression as actually applied to the published mic track (differs from the setting after a fallback). */
  noise: { active: AudioSettings['noiseSuppressionMode']; fallback: NoiseFallbackReason | null };
}

export interface VoiceClientOptions {
  settings?: Partial<VoiceSettings>;
  /** Provide an E2EE handle from createE2EE() */
  e2ee?: { keyProvider: BaseKeyProvider; worker: Worker };
  /** Called when the session ended for good: removed by a moderator / replaced elsewhere ('server') or every retry failed ('error'). */
  onDisconnected?: (reason: 'client' | 'server' | 'error') => void;
  /** Fetches a fresh token for a full rejoin when LiveKit's own resume fails. Without it there is no auto-rejoin. */
  getToken?: (channelId: string) => Promise<Pick<VoiceToken, 'token' | 'url'>>;
  /** Fired after an automatic rejoin succeeded (the app re-announces its gateway voice state). */
  onReconnected?: () => void;
  /** Fired when the session drops and the client starts recovering. */
  onConnectionLost?: (reason: LossReason) => void;
  /** Join timeout (signalling + ICE). Default 15s. */
  connectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  backoff?: BackoffOptions;
  roomOptions?: Partial<RoomOptions>;
}

const ATTR_HAND = 'jv.hand';
const ATTR_PRIORITY = 'jv.priority';

export class VoiceClient {
  readonly room: Room;
  private listeners = new Set<() => void>();
  private snap: VoiceSnapshot;
  private speaking = initialSpeaking;
  private userVolumes = new Map<string, number>();
  private userMuted = new Set<string>();
  private boostAudio = new AudioBoost({ outputDeviceId: () => this.snap?.settings.audio.outputDeviceId });
  private selfMuted = false;
  private preDeafenMuted = false;
  private pttActive = false;
  private stopPtt: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private audioHost: HTMLElement | undefined;
  private statsPrev = new Map<string, StatsSample>();
  private supportedCodecs: string[];
  private notifyQueued = false;
  private rnnoiseAttached = false;
  private micGate: { ctx: AudioContext; analyser: AnalyserNode; buf: Float32Array; src: MediaStreamAudioSourceNode; track: MediaStreamTrack } | undefined;
  private opts: VoiceClientOptions;
  private rc: ReconnectState;
  private nextRetryAt: number | null = null;
  private leaving = false;
  private rejoinRun = 0;
  private wakeSleep: (() => void) | undefined;
  private channelId: string | null = null;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private connPrev: ConnSample | undefined;
  private intent = { camera: false, cameraDeviceId: undefined as string | undefined, screen: false };
  private unbindWindow: (() => void) | undefined;
  private hiddenAt = 0;

  constructor(opts: VoiceClientOptions = {}) {
    this.opts = opts;
    this.rc = initialReconnect(opts.maxReconnectAttempts);
    const settings: VoiceSettings = { ...DEFAULT_SETTINGS, ...opts.settings, audio: { ...DEFAULT_AUDIO, ...opts.settings?.audio } };
    const platform = detectPlatform();
    this.supportedCodecs = detectSupportedVideoCodecs();
    const ra = resolveAudio(settings.audio);
    // Prefer AV1/VP9 when the browser can encode them; H264 is the compatibility backup. VP8 is the last resort.
    const initialCodec = pickCodec(this.supportedCodecs, settings.codec);
    this.room = new Room({
      // adaptiveStream + dynacast: subscribers only pull the layer they can display, and the publisher stops
      // sending layers nobody watches. This is what makes the simulcast ladder above worthwhile.
      adaptiveStream: { pauseVideoInBackground: true },
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
      webAudioMix: false, // keep HTMLAudioElement path: required for setSinkId + iOS reliability
      audioCaptureDefaults: { ...ra.capture },
      audioOutput: settings.audio.outputDeviceId ? { deviceId: settings.audio.outputDeviceId } : undefined,
      // Camera default: 1080p30 (auto). setCamera() always passes explicit per-attempt constraints on top.
      videoCaptureDefaults: { resolution: { width: 1920, height: 1080, frameRate: 30 } },
      publishDefaults: {
        audioPreset: { maxBitrate: ra.publish.audioBitrate },
        dtx: ra.publish.dtx, red: ra.publish.red, forceStereo: ra.publish.forceStereo,
        videoCodec: initialCodec as VideoCodec,
        backupCodec: initialCodec === 'h264' || initialCodec === 'vp8' ? false : { codec: 'h264' },
        simulcast: true, degradationPreference: 'maintain-framerate',
      },
      ...(opts.e2ee ? { e2ee: { keyProvider: opts.e2ee.keyProvider, worker: opts.e2ee.worker } } : {}),
      ...opts.roomOptions,
    });
    this.snap = {
      status: 'idle', error: null, channelId: null, participants: [], speaking: this.speaking,
      muted: false, deafened: false, cameraOn: false, screenOn: false, pttActive: false,
      networkQuality: 'unknown', audioBlocked: false, e2ee: !!opts.e2ee, platform,
      devices: { audioinput: [], audiooutput: [], videoinput: [] },
      settings, activeCodec: null,
      reconnect: { phase: 'idle', attempt: 0, maxAttempts: this.rc.maxAttempts, nextRetryAt: null, reason: null },
      connection: null, serverUrl: null, serverVersion: null, screenResumeNeeded: false,
      noise: { active: settings.audio.noiseSuppression ? settings.audio.noiseSuppressionMode : 'off', fallback: null },
    };
    this.bindRoom();
    this.bindWindow();
  }

  // ---- store API (useSyncExternalStore friendly) ----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snap;
  private emit(patch: Partial<VoiceSnapshot> = {}) {
    this.snap = { ...this.snap, ...patch, participants: this.buildParticipants(), speaking: this.speaking, pttActive: this.pttActive };
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => { this.notifyQueued = false; this.listeners.forEach((l) => l()); });
  }
  private fail(err: unknown, ctx: 'media' | 'screen' | 'connect' | 'token' = 'media'): VoiceError {
    const e = mapVoiceError(err, ctx);
    this.emit({ error: e });
    return e;
  }
  reportError(err: unknown, ctx: 'media' | 'screen' | 'connect' | 'token' = 'media') { return this.fail(err, ctx); }
  clearError() { this.emit({ error: null }); }

  // ---- connection ----
  private rcDispatch(e: ReconnectEvent) {
    this.rc = reconnectReducer(this.rc, e, this.opts.backoff ?? DEFAULT_BACKOFF);
    if (this.rc.phase !== 'waiting') this.nextRetryAt = null;
    this.emit({ status: statusOf(this.rc.phase), reconnect: this.reconnectView() });
  }
  private reconnectView(): VoiceSnapshot['reconnect'] {
    return { phase: this.rc.phase, attempt: this.rc.attempt, maxAttempts: this.rc.maxAttempts, nextRetryAt: this.nextRetryAt, reason: this.rc.reason };
  }

  /** Join: signalling + ICE must come up within `connectTimeoutMs`, otherwise the real reason is thrown (never hangs). */
  async connect(token: Pick<VoiceToken, 'token' | 'url'>, channelId: string): Promise<void> {
    this.rejoinRun++; // cancel a running auto-rejoin
    this.channelId = channelId;
    this.intent = { camera: false, cameraDeviceId: undefined, screen: false };
    this.rc = initialReconnect(this.rc.maxAttempts);
    this.emit({ error: null, channelId, screenResumeNeeded: false });
    this.rcDispatch({ type: 'want' });
    try {
      await this.establish(token);
    } catch (e) {
      if (this.rc.phase === 'idle') throw { code: 'unknown', message: 'Cancelled', cause: e } satisfies VoiceError; // cancelled by disconnect(): stay idle
      this.rcDispatch({ type: 'leave' });
      this.emit({ status: 'disconnected' });
      throw this.fail(e, 'connect');
    }
    if (this.rc.phase === 'idle') throw { code: 'unknown', message: 'Cancelled' } satisfies VoiceError;
    this.rcDispatch({ type: 'connected' });
    await this.afterConnect();
  }

  private async establish(token: Pick<VoiceToken, 'token' | 'url'>): Promise<void> {
    if (this.room.state !== ConnectionState.Disconnected) await this.shutdownRoom();
    const total = this.opts.connectTimeoutMs ?? 15_000;
    this.emit({ serverUrl: token.url, serverVersion: null });
    let signalUp = false;
    const onSignal = () => { signalUp = true; };
    this.room.once(RoomEvent.SignalConnected, onSignal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error(signalUp ? 'Timed out waiting for the media connection' : 'Timed out connecting to the voice server'), { name: 'VoiceConnectTimeout', phase: signalUp ? 'ice' : 'signal' })), total);
    });
    try {
      await Promise.race([
        this.room.connect(token.url, token.token, { autoSubscribe: true, maxRetries: 0, websocketTimeout: Math.max(5000, total - 4000), peerConnectionTimeout: Math.max(8000, total - 3000) }),
        timeout,
      ]);
    } catch (e) {
      await this.shutdownRoom().catch(() => {});
      throw e;
    } finally { clearTimeout(timer); this.room.off(RoomEvent.SignalConnected, onSignal); }
    this.emit({ serverVersion: this.room.serverInfo?.version ?? null });
  }

  /** Disconnect the Room without letting the Disconnected handler treat it as a connection loss. */
  private async shutdownRoom() {
    this.leaving = true;
    try { await this.room.disconnect(true); } finally { this.leaving = false; }
  }

  private async afterConnect() {
    this.startPolling();
    this.startStatsPolling();
    this.setupPtt();
    this.ensureAudioHost();
    await this.refreshDevices();
    this.emit({ status: 'connected', audioBlocked: !this.room.canPlaybackAudio });
    try { await this.applyMicState(true); } catch (e) { this.fail(e, 'media'); }
  }

  private stopTimers() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = undefined; this.connPrev = undefined;
    this.stopPtt?.(); this.stopPtt = undefined;
    this.teardownGate();
    this.rnnoiseAttached = false;
    this.boostAudio.releaseAll();
  }

  /** User leave. Cancels any recovery in progress and forgets camera/screen intent. */
  async disconnect(): Promise<void> {
    this.rejoinRun++; this.wakeSleep?.();
    this.stopTimers();
    this.rc = initialReconnect(this.rc.maxAttempts); this.nextRetryAt = null;
    this.intent = { camera: false, cameraDeviceId: undefined, screen: false };
    await this.shutdownRoom();
    this.audioHost?.remove(); this.audioHost = undefined;
    this.speaking = initialSpeaking; this.channelId = null;
    this.emit({ status: 'idle', channelId: null, cameraOn: false, screenOn: false, connection: null, screenResumeNeeded: false, reconnect: this.reconnectView() });
  }

  /** Manual "Retry" after recovery gave up (or to skip the backoff wait). */
  retry() {
    if (this.rc.phase === 'waiting') { this.wakeSleep?.(); return; }
    if (this.rc.phase === 'failed' && this.channelId) { this.rcDispatch({ type: 'retry-now' }); void this.runRejoin(); }
  }

  private onLost(reason: LossReason) {
    this.stopTimers();
    this.rcDispatch({ type: 'lost', reason });
    if (!this.rc.wanted) { this.emit({ status: 'disconnected', connection: null }); this.opts.onDisconnected?.('server'); return; }
    this.opts.onConnectionLost?.(reason);
    if (this.opts.getToken) void this.runRejoin();
    else { this.rcDispatch({ type: 'attempt-failed', fatal: true }); this.opts.onDisconnected?.('error'); }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); res(); }
      this.wakeSleep = () => { this.wakeSleep = undefined; done(); };
    });
  }

  /** Full rejoin loop: exponential backoff, a fresh token every attempt, restoring mute/devices/camera on success. */
  private async runRejoin() {
    const run = ++this.rejoinRun; const alive = () => run === this.rejoinRun && this.rc.wanted;
    const channelId = this.channelId;
    if (!channelId || !this.opts.getToken) return;
    while (alive()) {
      if (this.rc.phase === 'waiting') {
        this.nextRetryAt = Date.now() + this.rc.delayMs; this.emit({ reconnect: this.reconnectView() });
        await this.sleep(backoffDelay(this.rc.attempt, this.opts.backoff ?? DEFAULT_BACKOFF, 0.2));
        // offline: wait for the browser to come back instead of burning attempts
        while (alive() && typeof navigator !== 'undefined' && navigator.onLine === false) await this.sleep(30_000);
        if (!alive()) return;
      }
      this.rcDispatch({ type: 'attempt-start' });
      try {
        let tok: Pick<VoiceToken, 'token' | 'url'>;
        try { tok = await this.opts.getToken(channelId); } catch (e) { const st = (e as any)?.status; const err: any = this.fail(e, 'token'); err.fatal = st === 400 || st === 401 || st === 403 || st === 404; throw err; }
        if (!alive()) return;
        await this.establish(tok);
        if (!alive()) { await this.shutdownRoom().catch(() => {}); return; }
        this.rcDispatch({ type: 'connected' });
        this.emit({ error: null });
        await this.afterConnect();
        await this.restoreIntent();
        this.opts.onReconnected?.();
        return;
      } catch (e: any) {
        if (!alive()) return;
        const err = e?.code ? e : this.fail(e, 'connect');
        this.emit({ error: err });
        this.rcDispatch({ type: 'attempt-failed', fatal: !!e?.fatal });
        if (!this.rc.wanted) { this.emit({ status: 'disconnected', connection: null }); this.opts.onDisconnected?.('error'); return; }
      }
    }
  }

  /** After a rejoin: bring the camera back; a screen share needs a fresh user gesture, so just flag it. */
  private async restoreIntent() {
    if (this.intent.camera) { try { await this.setCamera(true, this.intent.cameraDeviceId); } catch { /* the user can re-enable */ } }
    if (this.intent.screen) {
      try { await this.startScreenShare(); this.emit({ screenResumeNeeded: false }); }
      catch { this.emit({ screenResumeNeeded: true, error: null }); }
    }
  }

  /** Clear the "resume your screen share" prompt (user dismissed it or shared again). */
  dismissScreenResume() { this.intent.screen = false; this.emit({ screenResumeNeeded: false }); }

  private bindWindow() {
    if (typeof window === 'undefined') return;
    const wake = () => { if (this.rc.phase === 'waiting') this.wakeSleep?.(); };
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { this.hiddenAt = Date.now(); return; }
      // back from sleep / background: a dead socket can take LiveKit ~15s to notice; skip our backoff if we're already recovering
      wake();
      if (this.rc.phase === 'failed' && Date.now() - this.hiddenAt > 1000) this.retry();
    };
    const onOnline = () => { wake(); if (this.rc.phase === 'failed') this.retry(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', onVisible);
    this.unbindWindow = () => { window.removeEventListener('online', onOnline); window.removeEventListener('pageshow', wake); document.removeEventListener('visibilitychange', onVisible); };
  }

  private startStatsPolling() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.connPrev = undefined;
    const tick = async () => {
      try {
        const pm: any = (this.room.engine as any)?.pcManager;
        const reports = (await Promise.all([pm?.publisher?.getStats?.(), pm?.subscriber?.getStats?.()])).filter(Boolean) as any[];
        if (!reports.length) return;
        const { stats, sample } = parseConnectionStats(reports, Date.now(), this.connPrev);
        this.connPrev = sample;
        this.emit({ connection: stats });
      } catch { /* stats are best effort */ }
    };
    void tick();
    this.statsTimer = setInterval(() => void tick(), 2000);
  }

  async dispose() { this.unbindWindow?.(); await this.disconnect(); this.listeners.clear(); }

  // ---- audio ----
  get isMicActive() { return !this.selfMuted && !this.snap.deafened; }

  async setMuted(muted: boolean) {
    this.selfMuted = muted;
    this.emit({ muted });
    await this.applyMicState();
  }
  toggleMute = () => this.setMuted(!this.selfMuted);
  /** Pre-seed mute/deafen before connecting (no side effects until connect). */
  prepare(o: { muted?: boolean; deafened?: boolean }) {
    if (this.room.state !== ConnectionState.Disconnected) return;
    const deaf = !!o.deafened;
    this.preDeafenMuted = !!o.muted;
    this.selfMuted = deaf || !!o.muted;
    this.snap = { ...this.snap, muted: this.selfMuted, deafened: deaf };
  }

  async setDeafened(deaf: boolean) {
    if (deaf === this.snap.deafened) return;
    if (deaf) { this.preDeafenMuted = this.selfMuted; this.selfMuted = true; }
    else this.selfMuted = this.preDeafenMuted;
    this.emit({ deafened: deaf, muted: this.selfMuted });
    this.applyVolumes();
    await this.applyMicState();
  }
  toggleDeafen = () => this.setDeafened(!this.snap.deafened);

  /** Decide whether mic should be live given mute/deafen/ptt/vad, and make sure a track is published when needed. */
  private async applyMicState(first = false) {
    const lp = this.room.localParticipant;
    const mode = this.snap.settings.inputMode;
    const wantPublished = !this.selfMuted && lp.permissions?.canPublish !== false;
    const pub = lp.getTrackPublication(Track.Source.Microphone);
    if (wantPublished && !pub) {
      const ra = resolveAudio(this.snap.settings.audio);
      await lp.setMicrophoneEnabled(true, ra.capture, {
        audioPreset: { maxBitrate: ra.publish.audioBitrate }, dtx: ra.publish.dtx, red: ra.publish.red, forceStereo: ra.publish.forceStereo,
      });
      await this.attachProcessors();
      this.setupGate();
    } else if (!wantPublished && pub && !pub.isMuted) {
      await pub.mute();
    } else if (wantPublished && pub?.isMuted) {
      await pub.unmute();
    }
    // gate: ptt / vad modes soft-disable the underlying MediaStreamTrack (no signalling churn)
    const mst = lp.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (mst) mst.enabled = mode === 'open' ? true : mode === 'ptt' ? this.pttActive : mst.enabled;
    if (first && this.selfMuted) this.emit();
    this.emit();
  }

  private async attachProcessors() {
    const s = this.snap.settings.audio;
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track: any = pub?.track;
    if (!track) return;
    const want = resolveAudio(s).useRnnoise;
    const requested = s.noiseSuppression ? s.noiseSuppressionMode : 'off';
    if (want && !this.rnnoiseAttached) {
      const res = await createRnnoiseProcessor();
      if (res.processor) {
        try { await track.setProcessor(res.processor); this.rnnoiseAttached = true; this.emit({ noise: { active: requested, fallback: null } }); return; }
        catch { await this.noiseFallback('start-failed', track); return; }
      }
      await this.noiseFallback(res.reason, track);
    } else if (!want && this.rnnoiseAttached) {
      await track.stopProcessor?.(); this.rnnoiseAttached = false;
      this.emit({ noise: { active: requested, fallback: null } });
    } else if (!want) this.emit({ noise: { active: requested, fallback: null } });
  }

  /** RNNoise could not run: keep the mic working with the browser's built-in suppression and tell the UI why. */
  private async noiseFallback(reason: NoiseFallbackReason, track: any) {
    try { await track.mediaStreamTrack?.applyConstraints?.({ noiseSuppression: true }); } catch { /* best effort */ }
    this.emit({ noise: { active: 'browser', fallback: reason } });
  }

  /** Update audio settings. Restarts the mic capture so constraints are re-applied. */
  private audioQueue: Promise<void> = Promise.resolve();
  /** Calls are serialized: two quick setting changes must not interleave unpublish/publish of the mic. */
  setAudioSettings(patch: Partial<AudioSettings>): Promise<void> {
    const run = this.audioQueue.then(() => this.applyAudioSettings(patch));
    this.audioQueue = run.catch(() => {});
    return run;
  }
  private async applyAudioSettings(patch: Partial<AudioSettings>) {
    const audio = { ...this.snap.settings.audio, ...patch };
    this.snap = { ...this.snap, settings: { ...this.snap.settings, audio } };
    const lp = this.room.localParticipant;
    this.room.options.audioCaptureDefaults = { ...resolveAudio(audio).capture };
    this.room.options.publishDefaults = { ...this.room.options.publishDefaults, ...this.audioPublishDefaults() };
    if (patch.outputDeviceId) await this.setOutputDevice(patch.outputDeviceId);
    if (lp.getTrackPublication(Track.Source.Microphone)) {
      this.rnnoiseAttached = false;
      this.teardownGate();
      // setMicrophoneEnabled(false) only *mutes* the track (the old capture, with the old constraints, would be unmuted again):
      // unpublish + stop it so the next applyMicState() captures afresh with the new constraints and processors.
      const mic = lp.getTrackPublication(Track.Source.Microphone)?.track;
      if (mic) await lp.unpublishTrack(mic, true);
      await this.applyMicState();
    } else this.emit();
  }
  private audioPublishDefaults() {
    const ra = resolveAudio(this.snap.settings.audio).publish;
    return { audioPreset: { maxBitrate: ra.audioBitrate }, dtx: ra.dtx, red: ra.red, forceStereo: ra.forceStereo };
  }

  setInputMode(mode: InputMode) {
    this.snap = { ...this.snap, settings: { ...this.snap.settings, inputMode: mode } };
    this.setupPtt();
    void this.applyMicState().catch((e) => this.fail(e));
  }
  setVadThreshold(v: number) { this.snap = { ...this.snap, settings: { ...this.snap.settings, vadThreshold: v } }; this.emit(); }
  setPttKey(code: string) {
    this.snap = { ...this.snap, settings: { ...this.snap.settings, pttCode: code } };
    this.setupPtt(); this.emit();
  }
  private setupPtt() {
    this.stopPtt?.(); this.stopPtt = undefined; this.pttActive = false;
    if (this.snap.settings.inputMode !== 'ptt') return;
    this.stopPtt = createPushToTalk({
      code: this.snap.settings.pttCode, releaseDelayMs: this.snap.settings.pttReleaseMs,
      onChange: (a) => { this.pttActive = a; void this.applyMicState().catch(() => {}); },
    });
  }

  // VAD gate: WebAudio analyser on the mic track
  private setupGate() {
    this.teardownGate();
    const mst = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (!mst || typeof AudioContext === 'undefined') return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([mst]));
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    src.connect(analyser);
    this.micGate = { ctx, analyser, buf: new Float32Array(analyser.fftSize), src, track: mst };
  }
  private teardownGate() {
    if (!this.micGate) return;
    try { this.micGate.src.disconnect(); void this.micGate.ctx.close(); } catch { /* noop */ }
    this.micGate = undefined;
  }
  private gateTick(now: number) {
    const g = this.micGate;
    if (!g || this.snap.settings.inputMode !== 'vad' || this.selfMuted) return;
    g.analyser.getFloatTimeDomainData(g.buf as Float32Array<ArrayBuffer>);
    let sum = 0; for (const v of g.buf) sum += v * v;
    const rms = Math.sqrt(sum / g.buf.length);
    if (rms >= this.snap.settings.vadThreshold) { g.track.enabled = true; this.vadHeldUntil = now + 400; }
    else if (now > this.vadHeldUntil) g.track.enabled = false;
  }
  private vadHeldUntil = 0;

  async setInputDevice(deviceId: string) { await this.room.switchActiveDevice('audioinput', deviceId, true); await this.setAudioDeviceState({ inputDeviceId: deviceId }); }
  async setOutputDevice(deviceId: string) {
    try { await this.room.switchActiveDevice('audiooutput', deviceId); } catch (e) { this.fail(e); }
    await this.setAudioDeviceState({ outputDeviceId: deviceId });
  }
  async setCameraDevice(deviceId: string) { this.intent.cameraDeviceId = deviceId; await this.room.switchActiveDevice('videoinput', deviceId, true); this.emit(); }
  private async setAudioDeviceState(p: Partial<AudioSettings>) {
    this.snap = { ...this.snap, settings: { ...this.snap.settings, audio: { ...this.snap.settings.audio, ...p } } };
    this.emit();
  }

  /** Per-user volume 0..2 (1 = 100%). The app persists it and replays it with syncUserAudio(). */
  setUserVolume(identity: string, volume: number) {
    this.userVolumes.set(identity, clampUserVolume(volume));
    this.applyVolumes(); this.emit();
  }
  getUserVolume(identity: string) { return this.userVolumes.get(identity) ?? 1; }
  /** Local-only mute of one participant (mic + screen-share audio); the volume setting is kept for when they are unmuted. */
  setUserMuted(identity: string, muted: boolean) {
    if (muted) this.userMuted.add(identity); else this.userMuted.delete(identity);
    this.applyVolumes(); this.emit();
  }
  isUserMuted(identity: string) { return this.userMuted.has(identity); }
  /** Replace all per-user audio settings at once (volumes 0..2, muted flags), e.g. from persisted preferences. */
  syncUserAudio(volumes: Record<string, number>, muted: Record<string, boolean>) {
    this.userVolumes = new Map(Object.entries(volumes).map(([k, v]) => [k, clampUserVolume(v)]));
    this.userMuted = new Set(Object.entries(muted).filter(([, m]) => m).map(([k]) => k));
    this.applyVolumes(); this.emit();
  }

  private isPriority(p: Participant) { return p.attributes?.[ATTR_PRIORITY] === '1'; }
  private applyVolumes() {
    const remotes = Array.from(this.room.remoteParticipants.values());
    const prioActive = remotes.some((p) => this.isPriority(p) && p.isSpeaking) ||
      (this.isPriority(this.room.localParticipant) && this.room.localParticipant.isSpeaking);
    const selfIsPriority = this.isPriority(this.room.localParticipant);
    const live = new Set<string>();
    for (const p of remotes) {
      const base = this.snap.deafened || this.userMuted.has(p.identity) ? 0 : this.getUserVolume(p.identity);
      const v = this.snap.deafened ? 0 : effectiveVolume(base, { isPrioritySpeakerActive: prioActive, selfIsPriority, targetIsPriority: this.isPriority(p) });
      for (const src of [Track.Source.Microphone, Track.Source.ScreenShareAudio] as const) {
        const key = `${p.identity}:${src}`;
        const mst = p.getTrackPublication(src)?.track?.mediaStreamTrack;
        // > 100 %: element silent + Web Audio gain; otherwise plain element volume (never above 1: that throws)
        if (v > 1 && mst && this.boostAudio.boost(key, mst, v)) { p.setVolume(0, src); live.add(key); }
        else { this.boostAudio.release(key); p.setVolume(Math.min(1, v), src); }
      }
    }
    this.boostAudio.retain(live);
  }

  /** Requires PRIORITY_SPEAKER permission (enforced by the app; the attribute is advisory). */
  async setPrioritySpeaker(on: boolean) { await this.room.localParticipant.setAttributes({ [ATTR_PRIORITY]: on ? '1' : '0' }); }
  /** Stage: raise/lower hand (request to speak). */
  async setHandRaised(on: boolean) { await this.room.localParticipant.setAttributes({ [ATTR_HAND]: on ? '1' : '0' }); }

  /** Browser autoplay unlock: call from a user gesture. */
  async unlockAudio() { try { await this.room.startAudio(); } catch (e) { this.fail(e); } this.emit({ audioBlocked: !this.room.canPlaybackAudio }); }

  // ---- video ----
  private codecFor(): VideoCodecName { return pickCodec(this.supportedCodecs, this.snap.settings.codec); }

  private publishOptsFor(source: StreamSource, presetId: StreamPresetId, hint: ContentHint) {
    const codec = this.codecFor();
    const platform = this.snap.platform;
    const r = selectPreset(presetId, codec, hint, mobileConstraints(platform));
    const svc = isScalableCodec(codec);
    const layers = simulcastLayers(r, codec, hint).map((l) => new VideoPreset(l.width, l.height, l.maxBitrateKbps * 1000, l.fps));
    const encoding = { maxBitrate: r.maxBitrateKbps * 1000, maxFramerate: r.fps };
    const o: TrackPublishOptions = {
      videoCodec: codec as VideoCodec,
      backupCodec: codec === 'h264' || codec === 'vp8' ? false : { codec: 'h264' },
      simulcast: !svc,
      ...(svc ? { scalabilityMode: 'L3T3_KEY' as const } : {}),
      degradationPreference: hint === 'detail' || hint === 'text' ? 'maintain-resolution' : 'maintain-framerate',
      ...(source === 'camera'
        ? { videoEncoding: encoding, videoSimulcastLayers: layers }
        : { screenShareEncoding: encoding, screenShareSimulcastLayers: layers }),
    };
    return { options: o, resolved: r, codec };
  }

  /** Camera publish options for one quality attempt: simulcast ladder, bitrate cap, codec fallback, motion hint. */
  private cameraPublishOpts(encoding: CameraEncoding, codec: VideoCodecName): TrackPublishOptions {
    const svc = isScalableCodec(codec);
    const layers = encoding.layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrateKbps * 1000, l.fps));
    return {
      videoCodec: codec as VideoCodec,
      backupCodec: codec === 'h264' || codec === 'vp8' ? false : { codec: 'h264' },
      simulcast: !svc && layers.length > 0,
      ...(svc ? { scalabilityMode: 'L3T3_KEY' as const } : {}),
      degradationPreference: 'maintain-framerate',
      videoEncoding: { maxBitrate: encoding.maxBitrateKbps * 1000, maxFramerate: encoding.fps },
      videoSimulcastLayers: layers,
    };
  }

  async setCamera(on: boolean, deviceId?: string) {
    const lp = this.room.localParticipant;
    try {
      if (!on) { this.intent.camera = false; await lp.setCameraEnabled(false); this.emit({ cameraOn: false }); return; }
      const codec = this.codecFor();
      const plan = cameraPlan(this.snap.settings.cameraQuality, this.snap.settings.cameraFps, codec, mobileConstraints(this.snap.platform));
      let lastError: unknown;
      // Ask for the top quality first and step down (1080p -> 720p -> 480p) if the camera rejects it.
      for (const encoding of plan.attempts) {
        const cap: VideoCaptureOptions = {
          resolution: { width: encoding.width, height: encoding.height, frameRate: encoding.fps },
          ...(deviceId ? { deviceId } : {}),
          ...(this.snap.platform.isMobile ? { facingMode: 'user' as const } : {}),
        };
        try {
          await lp.setCameraEnabled(true, cap, this.cameraPublishOpts(encoding, codec));
          // contentHint is not part of LiveKit's capture options: set it on the real track so the encoder optimises for motion.
          const track = lp.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
          if (track) track.contentHint = plan.contentHint;
          this.intent.camera = true; this.intent.cameraDeviceId = deviceId ?? this.intent.cameraDeviceId;
          this.emit({ cameraOn: true, activeCodec: codec });
          return;
        } catch (e) {
          lastError = e;
          try { await lp.setCameraEnabled(false); } catch { /* a failed attempt may never have started */ }
        }
      }
      throw lastError;
    } catch (e) { this.emit({ cameraOn: !!lp.getTrackPublication(Track.Source.Camera) }); throw this.fail(e, 'media'); }
  }

  /** Change camera quality / frame rate. Re-publishes only when the camera is on, so the next frame uses the new preset. */
  async setCameraSettings(patch: { quality?: CameraQuality; fps?: number }) {
    const cur = this.snap.settings;
    const quality = patch.quality ?? cur.cameraQuality;
    const fps = normalizeCameraFps(patch.fps ?? cur.cameraFps);
    if (quality === cur.cameraQuality && fps === cur.cameraFps) return;
    this.snap = { ...this.snap, settings: { ...cur, cameraQuality: quality, cameraFps: fps } };
    this.emit();
    if (!this.snap.cameraOn) return;
    const deviceId = this.intent.cameraDeviceId;
    await this.setCamera(false);
    await this.setCamera(true, deviceId);
  }

  async startScreenShare(o: { preset?: StreamPresetId; hint?: ContentHint; audio?: boolean } = {}) {
    if (!this.snap.platform.canScreenShare) { const e = { code: 'unsupported' as const, message: 'Screen sharing is not supported on this device/browser.' }; this.emit({ error: e }); throw e; }
    const preset = o.preset ?? this.snap.settings.screenPreset;
    const hint = o.hint ?? this.snap.settings.screenHint;
    const audio = o.audio ?? this.snap.settings.screenAudio;
    const { options, resolved, codec } = this.publishOptsFor('screen', preset, hint);
    const cap: ScreenShareCaptureOptions = {
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } as any : false,
      systemAudio: audio ? 'include' : 'exclude',
      resolution: { width: resolved.width, height: resolved.height, frameRate: resolved.fps },
      contentHint: hint,
      surfaceSwitching: 'include', selfBrowserSurface: 'exclude',
    };
    try {
      await this.room.localParticipant.setScreenShareEnabled(true, cap, options);
      this.snap = { ...this.snap, settings: { ...this.snap.settings, screenPreset: preset, screenHint: hint, screenAudio: audio } };
      this.intent.screen = true;
      this.emit({ screenOn: true, activeCodec: codec, screenResumeNeeded: false });
    } catch (e) { this.emit({ screenOn: false }); throw this.fail(e, 'screen'); }
  }
  async stopScreenShare() { this.intent.screen = false; this.emit({ screenResumeNeeded: false }); await this.room.localParticipant.setScreenShareEnabled(false); this.emit({ screenOn: false }); }

  /** Change live screen-share quality without re-prompting the picker (applyConstraints + sender bitrate). */
  async setLiveStreamQuality(presetId: StreamPresetId, hint?: ContentHint) {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) return false;
    const h = hint ?? this.snap.settings.screenHint;
    const r = selectPreset(presetId, this.codecFor(), h, mobileConstraints(this.snap.platform));
    try {
      await track.mediaStreamTrack.applyConstraints({ width: r.width, height: r.height, frameRate: r.fps });
      track.mediaStreamTrack.contentHint = h;
      const sender = track.sender;
      if (sender) {
        const p = sender.getParameters();
        for (const enc of p.encodings ?? []) {
          if (!enc.rid || enc.rid === 'f' || (p.encodings?.length ?? 0) === 1) { enc.maxBitrate = r.maxBitrateKbps * 1000; enc.maxFramerate = r.fps; }
        }
        await sender.setParameters(p);
      }
      this.snap = { ...this.snap, settings: { ...this.snap.settings, screenPreset: presetId, screenHint: h } };
      this.emit();
      return true;
    } catch { return false; }
  }

  setContentHint(hint: ContentHint) {
    const t = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (t) t.mediaStreamTrack.contentHint = hint;
  }

  // ---- viewer side ----
  /** Viewer picks a quality for a remote video; 'auto' lets adaptiveStream decide. */
  setViewerQuality(identity: string, source: StreamSource, q: ViewerQuality) {
    const p = this.room.remoteParticipants.get(identity);
    const pub = p?.getTrackPublication(source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera) as RemoteTrackPublication | undefined;
    if (!pub) return;
    const dims = pub.dimensions ?? { width: 3840, height: 2160 };
    const d = viewerQualityToDimensions(q, dims);
    if (!d) { pub.setVideoQuality(2 as any); return; } // HIGH; adaptiveStream still caps by element size
    pub.setVideoDimensions(d);
  }
  /** Allow/deny receiving a remote stream (watch / stop watching). */
  setWatching(identity: string, source: StreamSource, watch: boolean) {
    const p = this.room.remoteParticipants.get(identity);
    const pub = p?.getTrackPublication(source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera) as RemoteTrackPublication | undefined;
    pub?.setSubscribed(watch);
    const a = p?.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
    if (source === 'screen') a?.setSubscribed(watch);
  }

  getVideoTrack(identity: string, source: StreamSource): LocalVideoTrack | RemoteVideoTrack | undefined {
    const p = identity === this.room.localParticipant.identity ? this.room.localParticipant : this.room.remoteParticipants.get(identity);
    return p?.getTrackPublication(source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera)?.videoTrack as any;
  }

  /** Poll WebRTC stats for the stats overlay. Call every ~1s. */
  /** My own camera or screen share as a new MediaStream of cloned tracks (screen audio included), for local clip recording. Null when that source is off. */
  getLocalMediaStream(source: StreamSource): MediaStream | null {
    const lp = this.room.localParticipant;
    const video = lp.getTrackPublication(source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera)?.track?.mediaStreamTrack;
    if (!video || video.readyState === 'ended') return null;
    const tracks = [video.clone()];
    if (source === 'screen') {
      const audio = lp.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack;
      if (audio && audio.readyState !== 'ended') tracks.push(audio.clone());
    }
    return new MediaStream(tracks);
  }

  async getStats(identity: string, source: StreamSource): Promise<StreamStats | null> {
    const t: any = this.getVideoTrack(identity, source);
    if (!t) return null;
    const local = identity === this.room.localParticipant.identity;
    const target: RTCRtpSender | RTCRtpReceiver | undefined = local ? t.sender : t.receiver;
    if (!target) return null;
    const key = `${identity}:${source}`;
    const report = await target.getStats();
    const { stats, sample } = parseVideoStats(report as any, local ? 'outbound' : 'inbound', this.statsPrev.get(key));
    this.statsPrev.set(key, sample);
    return stats;
  }

  // ---- E2EE ----
  async setE2EE(enabled: boolean) { await this.room.setE2EEEnabled(enabled); this.emit({ e2ee: enabled }); }

  // ---- devices ----
  async refreshDevices() {
    const get = (k: MediaDeviceKind) => Room.getLocalDevices(k, false).catch(() => [] as MediaDeviceInfo[]);
    const [audioinput, audiooutput, videoinput] = await Promise.all([get('audioinput'), get('audiooutput'), get('videoinput')]);
    this.emit({ devices: { audioinput, audiooutput, videoinput } });
  }
  /** Ask for permission so device labels are populated. */
  async requestDevicePermissions(kinds: { audio?: boolean; video?: boolean } = { audio: true }) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: !!kinds.audio, video: !!kinds.video });
      s.getTracks().forEach((t) => t.stop());
      await this.refreshDevices();
    } catch (e) { throw this.fail(e, 'media'); }
  }

  // ---- internals ----
  private ensureAudioHost() {
    if (this.audioHost || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.className = 'jv-audio-host'; el.style.display = 'none';
    document.body.appendChild(el);
    this.audioHost = el;
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      const now = Date.now();
      const levels: Record<string, number> = {};
      const all: Participant[] = [this.room.localParticipant, ...this.room.remoteParticipants.values()];
      for (const p of all) levels[p.identity] = p.audioLevel;
      // local VAD/ptt: level is 0 when track disabled, so no false indicator
      this.speaking = speakingReducer(this.speaking, { type: 'levels', now, levels, threshold: 0.02 });
      this.speaking = speakingReducer(this.speaking, { type: 'tick', now });
      this.gateTick(now);
      this.applyVolumes();
      this.emit();
    }, 100);
  }

  private bindRoom() {
    const r = this.room;
    const touch = () => this.emit();
    r.on(RoomEvent.ParticipantConnected, touch)
      .on(RoomEvent.ParticipantDisconnected, (p) => { this.speaking = speakingReducer(this.speaking, { type: 'remove', id: p.identity }); touch(); })
      .on(RoomEvent.TrackMuted, touch).on(RoomEvent.TrackUnmuted, touch)
      .on(RoomEvent.TrackPublished, touch).on(RoomEvent.TrackUnpublished, touch)
      .on(RoomEvent.LocalTrackPublished, touch)
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        // stopped while healthy (browser "Stop sharing" button, device unplugged) = the user's intent changed; a drop is not
        const healthy = !this.leaving && this.rc.phase === 'connected' && this.room.state === ConnectionState.Connected;
        if (pub.source === Track.Source.ScreenShare) { if (healthy) this.intent.screen = false; this.emit({ screenOn: false }); }
        if (pub.source === Track.Source.Camera) { if (healthy) this.intent.camera = false; this.emit({ cameraOn: false }); }
        touch();
      })
      .on(RoomEvent.TrackSubscribed, (track, _pub, _p) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.setAttribute('playsinline', ''); el.autoplay = true;
          this.ensureAudioHost(); this.audioHost?.appendChild(el);
          this.applyVolumes();
        }
        touch();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => { if (track.kind === Track.Kind.Audio) track.detach().forEach((e) => e.remove()); touch(); })
      .on(RoomEvent.ParticipantAttributesChanged, touch)
      .on(RoomEvent.ParticipantPermissionsChanged, () => { void this.applyMicState().catch(() => {}); touch(); })
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (p.isLocal) this.emit({ networkQuality: mapConnectionQuality(q) }); else touch(); })
      .on(RoomEvent.Reconnecting, () => this.rcDispatch({ type: 'resuming' }))
      .on(RoomEvent.SignalReconnecting, () => this.rcDispatch({ type: 'resuming' }))
      .on(RoomEvent.Reconnected, () => { this.rcDispatch({ type: 'connected' }); this.applyVolumes(); this.connPrev = undefined; })
      .on(RoomEvent.Disconnected, (reason) => {
        // only a live session counts as "lost"; join attempts report their own failure
        if (this.leaving || (this.rc.phase !== 'connected' && this.rc.phase !== 'resuming')) return;
        this.onLost(lossReasonOf(reason as number | undefined));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit({ audioBlocked: !r.canPlaybackAudio }))
      .on(RoomEvent.MediaDevicesChanged, () => { void this.refreshDevices(); })
      .on(RoomEvent.MediaDevicesError, (e) => { this.fail(e, 'media'); })
      .on(RoomEvent.ActiveDeviceChanged, touch);
    // device hot-plug fallback (some browsers don't fire MediaDevicesChanged before connect)
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { void this.refreshDevices(); });
    }
  }

  private buildParticipants(): ParticipantView[] {
    const r = this.room;
    if (r.state === ConnectionState.Disconnected && !r.localParticipant.identity) return [];
    const list: Participant[] = [r.localParticipant, ...r.remoteParticipants.values()];
    return list.map((p) => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const sp = this.speaking.speakers[p.identity];
      const local = p.isLocal;
      return {
        identity: p.identity, userId: p.identity, name: p.name || p.identity, isLocal: local,
        speaking: !!sp?.speaking && !(local && this.selfMuted), level: sp?.level ?? 0,
        micMuted: local ? this.selfMuted : !mic || mic.isMuted,
        cameraOn: !!p.getTrackPublication(Track.Source.Camera) && !p.getTrackPublication(Track.Source.Camera)!.isMuted,
        screenOn: !!p.getTrackPublication(Track.Source.ScreenShare),
        screenAudioOn: !!p.getTrackPublication(Track.Source.ScreenShareAudio),
        quality: mapConnectionQuality(p.connectionQuality), volume: local ? 1 : this.getUserVolume(p.identity), localMuted: !local && this.userMuted.has(p.identity),
        priority: this.isPriority(p), handRaised: p.attributes?.[ATTR_HAND] === '1',
        canPublish: p.permissions?.canPublish !== false, metadata: p.metadata,
      };
    });
  }
}

export type { RemoteParticipant, LocalParticipant, TrackPublication };
