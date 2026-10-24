import {
  Room, RoomEvent, Track, VideoPreset, LocalVideoTrack as LocalVideoTrackImpl, ConnectionState, ParticipantEvent,
  type Participant, type RemoteParticipant, type LocalParticipant, type TrackPublication,
  type RoomOptions, type TrackPublishOptions, type ScreenShareCaptureOptions, type VideoCaptureOptions,
  type LocalVideoTrack, type RemoteVideoTrack, type RemoteTrackPublication, type LocalTrackPublication,
  type VideoCodec, type BaseKeyProvider, type TrackProcessor,
} from 'livekit-client';
import type { VoiceToken } from '@jorcord/shared';
import { DEFAULT_AUDIO, resolveAudio, type AudioSettings } from './audio';
import { mapVoiceError, type VoiceError } from './errors';
import { mapConnectionQuality, type NetworkQuality, type StreamStats } from './network';
import { createRnnoiseProcessor, type NoiseFallbackReason, type RnnoiseProcessor } from './noise';
import { resolveScreenPlan, normalizeLock, type DegradationChoice, type QualityLock } from './screenQuality';
import { BitrateGovernor, bitrateLadder, parseScreenSignals } from './adaptation';
import { createPushToTalk, type PttOptions } from './ptt';
import { effectiveVolume, clampUserVolume, isPriorityIdentity, DuckGate } from './priority';
import { MicMonitor, MutedSpeakingDetector, MUTED_HINT_VISIBLE_MS } from './mutedSpeaking';
import { AudioBoost } from './boost';
import {
  cameraPlan, detectSupportedVideoCodecs, isScalableCodec, normalizeCameraFps, pickCodec, recommendBitrateKbps, selectPreset, simulcastLayers,
  viewerQualityToDimensions, type CameraEncoding, type CameraQuality, type ContentHint, type StreamPresetId, type VideoCodecName, type ViewerQuality,
} from './presets';
import { detectPlatform, mobileConstraints, type Platform } from './mobile';
import type { NativeScreenSession, NativeScreenSource } from './nativeScreen';
import { initialSpeaking, speakingReducer, type SpeakingState } from './speaking';
import { parseVideoStats, parseConnectionStats, type StatsSample, type ConnectionStats, type ConnSample } from './stats';
import {
  backoffDelay, initialReconnect, lossReasonOf, reconnectReducer, statusOf,
  type BackoffOptions, type LossReason, type ReconnectEvent, type ReconnectPhase, type ReconnectState, DEFAULT_BACKOFF,
} from './reconnect';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type InputMode = 'open' | 'vad' | 'ptt';
export type StreamSource = 'camera' | 'screen';

/** A processor that rewrites the published camera picture (see VoiceClient.setCameraProcessor). */
export type CameraProcessor = TrackProcessor<Track.Kind.Video>;

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
  /** What the encoder gives up first when the connection is tight (see screenQuality.ts). */
  screenDegradation: DegradationChoice;
  /** Manual quality lock (resolution / fps / bitrate); null = automatic. A locked share is never stepped down by the adaptive governor. */
  screenLock: QualityLock | null;
  codec: VideoCodecName | 'auto';
  /** Detect speech into a muted mic and raise `speakingWhileMuted` (the app shows a "you are muted" hint). Listens locally only. */
  mutedSpeakingHint: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  audio: DEFAULT_AUDIO, inputMode: 'open', pttCode: 'Backquote', pttReleaseMs: 200, vadThreshold: 0.03,
  cameraPreset: '720p30', cameraQuality: 'auto', cameraFps: 30,
  screenPreset: '1080p60', screenHint: 'motion', screenAudio: true, screenDegradation: 'auto', screenLock: null, codec: 'auto', mutedSpeakingHint: true,
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
  /** True for a few seconds after speech was detected on the muted mic (see `VoiceSettings.mutedSpeakingHint`). */
  speakingWhileMuted: boolean;
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
  /** Fired each time speech is detected on the muted mic (rate limited), in addition to the `speakingWhileMuted` snapshot flag. */
  onSpeakingWhileMuted?: () => void;
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
  /** Server-confirmed priority speakers (userIds); null = fall back to the advisory `jv.priority` attribute. */
  private prioritySet: Set<string> | null = null;
  private duckGate = new DuckGate();
  /** Go Live: identities that may receive my screen share (null = everyone). */
  private audience: Set<string> | null = null;
  private audienceSent = false;
  private mutedMonitor = new MicMonitor();
  private mutedDetector = new MutedSpeakingDetector();
  private mutedHintUntil = 0;
  private mutedMonitorBusy = false;
  private boostAudio = new AudioBoost({ outputDeviceId: () => this.snap?.settings.audio.outputDeviceId });
  private selfMuted = false;
  private preDeafenMuted = false;
  private pttActive = false;
  private stopPtt: (() => void) | undefined;
  private pttGlobalSource: PttOptions['globalSource'];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private audioHost: HTMLElement | undefined;
  private statsPrev = new Map<string, StatsSample>();
  private supportedCodecs: string[];
  private notifyQueued = false;
  private rnnoiseAttached = false;
  /** Optional video processor (background blur / replacement) applied to the *published* camera track. */
  private cameraProcessor: CameraProcessor | undefined;
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
  private nativeScreen: NativeScreenSource | undefined;
  private nativeSession: { session: NativeScreenSession; track: LocalVideoTrack } | undefined;

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
      speakingWhileMuted: false,
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
    await this.endNativeScreen();
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
    this.audienceSent = false; this.applyAudience();
    try { await this.applyMicState(true); } catch (e) { this.fail(e, 'media'); }
  }

  private stopTimers() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = undefined; this.connPrev = undefined;
    this.stopPtt?.(); this.stopPtt = undefined;
    this.teardownGate();
    this.mutedMonitor.stop(); this.mutedDetector.rearm(); this.mutedHintUntil = 0;
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
    if (this.intent.screen && this.snap.platform.nativeScreenShare) {
      this.emit({ screenResumeNeeded: true, error: null }); // the native consent dialog needs a user gesture
    } else if (this.intent.screen) {
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
        if (this.snap.screenOn && reports[0]) void this.adaptScreen(reports[0]);
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
      const res = await createRnnoiseProcessor({}, { tuning: resolveAudio(s).noiseTuning, onFallback: (reason) => { void this.noiseUnderrun(reason); } });
      if (res.processor) {
        try { await track.setProcessor(res.processor); this.rnnoiseAttached = true; this.rnnoiseProc = res.processor; this.emit({ noise: { active: requested, fallback: null } }); return; }
        catch { await this.noiseFallback('start-failed', track); return; }
      }
      await this.noiseFallback(res.reason, track);
    } else if (!want && this.rnnoiseAttached) {
      await track.stopProcessor?.(); this.rnnoiseAttached = false; this.rnnoiseProc = undefined;
      this.emit({ noise: { active: requested, fallback: null } });
    } else if (!want) this.emit({ noise: { active: requested, fallback: null } });
  }

  private rnnoiseProc?: RnnoiseProcessor;
  /** The worklet stalled or crashed mid-call (robotic / cut-out voice): drop it and keep the mic on the browser's suppression. */
  private async noiseUnderrun(reason: NoiseFallbackReason) {
    const track: any = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track || !this.rnnoiseAttached) return;
    try { await track.stopProcessor?.(); } catch { /* */ }
    this.rnnoiseAttached = false; this.rnnoiseProc = undefined;
    await this.noiseFallback(reason, track);
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
    // strength / wet-dry sliders: retune the running processor, no re-capture (the voice must not cut out while dragging)
    const keys = Object.keys(patch);
    if (keys.length && keys.every((k) => k === 'noiseStrength' || k === 'noiseMix') && this.rnnoiseAttached && this.rnnoiseProc) { this.rnnoiseProc.setTuning(resolveAudio(audio).noiseTuning); this.emit(); return; }
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
  /** Desktop: a press/release source that works while the window is unfocused (global hotkey). Pass undefined to go back to window-only keys. */
  setGlobalPttSource(src: PttOptions['globalSource']) { this.pttGlobalSource = src; this.setupPtt(); }
  private setupPtt() {
    this.stopPtt?.(); this.stopPtt = undefined; this.pttActive = false;
    if (this.snap.settings.inputMode !== 'ptt') return;
    this.stopPtt = createPushToTalk({
      code: this.snap.settings.pttCode, releaseDelayMs: this.snap.settings.pttReleaseMs, globalSource: this.pttGlobalSource,
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

  // "Speaking while muted": a private clone of the mic is metered while muted; the audio never leaves the device.
  setMutedSpeakingHint(on: boolean) {
    if (this.snap.settings.mutedSpeakingHint === on) return;
    this.snap = { ...this.snap, settings: { ...this.snap.settings, mutedSpeakingHint: on } };
    if (!on) { this.mutedMonitor.stop(); this.mutedHintUntil = 0; this.mutedDetector.rearm(); }
    this.emit(on ? {} : { speakingWhileMuted: false });
  }
  /** Mute state changes re-arm the hint so the first mumble after muting is reported. */
  private mutedTick(now: number) {
    const want = this.snap.settings.mutedSpeakingHint && this.selfMuted && !this.snap.deafened && this.snap.status === 'connected' && this.room.localParticipant.permissions?.canPublish !== false;
    if (!want) {
      if (this.mutedMonitor.active) { this.mutedMonitor.stop(); this.mutedDetector.rearm(); }
      if (this.snap.speakingWhileMuted) this.emit({ speakingWhileMuted: false });
      return;
    }
    const pubTrack = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (pubTrack && this.mutedMonitor.sourceId !== pubTrack.id) { this.mutedMonitor.start(pubTrack); }
    else if (!pubTrack && !this.mutedMonitor.active && !this.mutedMonitorBusy && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      // joined muted: no published mic yet, so open one only for the meter (the browser shows its mic indicator, as for any open mic)
      this.mutedMonitorBusy = true;
      void navigator.mediaDevices.getUserMedia({ audio: resolveAudio(this.snap.settings.audio).capture })
        .then((st) => {
          const t = st.getAudioTracks()[0];
          if (!t) return;
          if (this.selfMuted && this.snap.settings.mutedSpeakingHint && this.snap.status === 'connected') this.mutedMonitor.start(t, true); else t.stop();
        })
        .catch(() => { /* no mic permission: nothing to hint about */ })
        .finally(() => { this.mutedMonitorBusy = false; });
    }
    if (!this.mutedMonitor.active) return;
    if (this.mutedDetector.feed(now, this.mutedMonitor.level(), true)) {
      this.mutedHintUntil = now + MUTED_HINT_VISIBLE_MS;
      this.emit({ speakingWhileMuted: true });
      try { this.opts.onSpeakingWhileMuted?.(); } catch { /* app callback */ }
    } else if (this.snap.speakingWhileMuted && now > this.mutedHintUntil) this.emit({ speakingWhileMuted: false });
  }

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

  private isPriority(p: Participant) { return isPriorityIdentity(p.identity, p.attributes?.[ATTR_PRIORITY], this.prioritySet); }
  /**
   * Tell the client who the server says holds priority speaker (identities = user ids). Once set, the list is authoritative and the
   * participant attribute is ignored, so a member cannot duck the room by writing the attribute themselves. Pass null to go back.
   */
  setPrioritySpeakers(identities: Iterable<string> | null) {
    const next = identities ? new Set(identities) : null;
    const same = (!next && !this.prioritySet) || (!!next && !!this.prioritySet && next.size === this.prioritySet.size && [...next].every((i) => this.prioritySet!.has(i)));
    if (same) return;
    this.prioritySet = next;
    this.applyVolumes(); this.emit();
  }
  private applyVolumes() {
    const remotes = Array.from(this.room.remoteParticipants.values());
    const talking = remotes.some((p) => this.isPriority(p) && p.isSpeaking) ||
      (this.isPriority(this.room.localParticipant) && this.room.localParticipant.isSpeaking);
    const prioActive = this.duckGate.update(Date.now(), talking);
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

  /**
   * Sets the advisory `jv.priority` attribute (needs the `canUpdateOwnMetadata` grant, which Jorcord's token does not give out:
   * the server sets the attribute itself after checking PRIORITY_SPEAKER). Only useful for apps that mint their own tokens.
   */
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
    const s = this.snap.settings;
    // camera keeps the preset ladder; screen share goes through the plan (degradation preference, content defaults, manual lock)
    const plan = source === 'screen' ? resolveScreenPlan({ preset: presetId, hint, degradation: s.screenDegradation, lock: s.screenLock, codec, constraints: mobileConstraints(platform) }) : null;
    const base = selectPreset(presetId, codec, hint, mobileConstraints(platform));
    const r = plan ? { ...base, width: plan.width, height: plan.height, fps: plan.fps, maxBitrateKbps: plan.maxBitrateKbps } : base;
    const svc = isScalableCodec(codec);
    const layers = (plan ? plan.layers : simulcastLayers(r, codec, hint)).map((l) => new VideoPreset(l.width, l.height, l.maxBitrateKbps * 1000, l.fps));
    const encoding = { maxBitrate: r.maxBitrateKbps * 1000, maxFramerate: r.fps };
    const o: TrackPublishOptions = {
      videoCodec: codec as VideoCodec,
      backupCodec: codec === 'h264' || codec === 'vp8' ? false : { codec: 'h264' },
      simulcast: !svc,
      ...(svc ? { scalabilityMode: 'L3T3_KEY' as const } : {}),
      degradationPreference: plan ? plan.degradationPreference : hint === 'detail' || hint === 'text' ? 'maintain-resolution' : 'maintain-framerate',
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
          if (this.cameraProcessor) await this.applyCameraProcessor();
          return;
        } catch (e) {
          lastError = e;
          try { await lp.setCameraEnabled(false); } catch { /* a failed attempt may never have started */ }
        }
      }
      throw lastError;
    } catch (e) { this.emit({ cameraOn: !!lp.getTrackPublication(Track.Source.Camera) }); throw this.fail(e, 'media'); }
  }

  /**
   * Attach (or with `undefined` remove) a video processor on the published camera track, e.g. background blur/replacement. Remote participants
   * then receive the processed picture, not just the local preview. Remembered across camera re-publishes. Resolves false when the processor
   * could not start; the raw camera keeps working in that case.
   */
  async setCameraProcessor(processor: CameraProcessor | undefined): Promise<boolean> {
    this.cameraProcessor = processor;
    return this.applyCameraProcessor();
  }

  private async applyCameraProcessor(): Promise<boolean> {
    const track: any = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!track) return true; // applied when the camera is next enabled
    try {
      if (this.cameraProcessor) await track.setProcessor(this.cameraProcessor);
      else if (track.getProcessor?.()) await track.stopProcessor();
      return true;
    } catch {
      this.cameraProcessor = undefined;
      try { await track.stopProcessor?.(); } catch { /* already gone */ }
      return false;
    }
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

  /**
   * Enable screen sharing through a native capture plugin (Capacitor mobile apps). Resolves to whether it is available;
   * when it is, `platform.canScreenShare` / `platform.nativeScreenShare` turn true so the existing UI shows the button.
   */
  async setNativeScreenSource(source: NativeScreenSource | undefined): Promise<boolean> {
    this.nativeScreen = source;
    let ok = false;
    try { ok = !!source && (await source.isSupported()); } catch { ok = false; }
    this.nativeScreen = ok ? source : undefined;
    const base = detectPlatform();
    this.emit({ platform: ok ? { ...base, canScreenShare: true, nativeScreenShare: true } : base });
    return ok;
  }

  /** Native capture: frames arrive as a canvas-backed track (video only, no system audio). */
  private async startNativeScreenShare(o: { preset?: StreamPresetId; hint?: ContentHint }) {
    const src = this.nativeScreen!;
    const preset = o.preset ?? this.snap.settings.screenPreset;
    const hint = o.hint ?? this.snap.settings.screenHint;
    const { resolved, codec } = this.publishOptsFor('screen', preset, hint);
    await this.endNativeScreen();
    let session: NativeScreenSession | undefined;
    try {
      session = await src.start({ fps: 8, maxDimension: 1280 });
      session.track.contentHint = hint;
      const track = new LocalVideoTrackImpl(session.track, undefined, true);
      const opts: TrackPublishOptions = {
        source: Track.Source.ScreenShare, name: 'screen',
        videoCodec: codec as VideoCodec, backupCodec: false, simulcast: false,
        degradationPreference: 'maintain-resolution',
        // Snapshots of a phone screen: modest bitrate/framerate are plenty and keep thermal load and uplink low.
        screenShareEncoding: { maxBitrate: Math.min(resolved.maxBitrateKbps, 2500) * 1000, maxFramerate: 10 },
      };
      const s = session;
      this.nativeSession = { session: s, track };
      s.onEnded(() => { void this.endNativeScreen(); });
      await this.room.localParticipant.publishTrack(track, opts);
      this.snap = { ...this.snap, settings: { ...this.snap.settings, screenPreset: preset, screenHint: hint } };
      this.intent.screen = true;
      this.emit({ screenOn: true, activeCodec: codec, screenResumeNeeded: false });
    } catch (e) {
      await this.endNativeScreen(false);
      if (session) await session.stop().catch(() => {});
      this.emit({ screenOn: false });
      throw this.fail(e, 'screen');
    }
  }

  /** Stop native capture and unpublish its track. Idempotent; safe from the unpublish event handler. */
  private async endNativeScreen(unpublish = true) {
    const cur = this.nativeSession; if (!cur) return;
    this.nativeSession = undefined;
    if (unpublish) { try { await this.room.localParticipant.unpublishTrack(cur.track, true); } catch { /* room may already be gone */ } }
    await cur.session.stop().catch(() => {});
    this.emit({ screenOn: false });
  }

  async startScreenShare(o: { preset?: StreamPresetId; hint?: ContentHint; audio?: boolean } = {}) {
    if (this.nativeScreen && this.snap.platform.nativeScreenShare) return this.startNativeScreenShare(o);
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
  async stopScreenShare() { this.intent.screen = false; this.emit({ screenResumeNeeded: false }); await this.endNativeScreen(); await this.room.localParticipant.setScreenShareEnabled(false); this.emit({ screenOn: false }); }

  /** Change live screen-share quality without re-prompting the picker (applyConstraints + sender bitrate). */
  async setLiveStreamQuality(presetId: StreamPresetId, hint?: ContentHint) {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) return false;
    const h = hint ?? this.snap.settings.screenHint;
    const st = this.snap.settings;
    const r = resolveScreenPlan({ preset: presetId, hint: h, degradation: st.screenDegradation, lock: st.screenLock, codec: this.codecFor(), constraints: mobileConstraints(this.snap.platform) });
    try {
      await track.mediaStreamTrack.applyConstraints({ width: r.width, height: r.height, frameRate: r.fps });
      track.mediaStreamTrack.contentHint = h;
      const sender = track.sender;
      if (sender) {
        const p: any = sender.getParameters();
        for (const enc of p.encodings ?? []) {
          if (!enc.rid || enc.rid === 'f' || (p.encodings?.length ?? 0) === 1) { enc.maxBitrate = r.maxBitrateKbps * 1000; enc.maxFramerate = r.fps; }
        }
        p.degradationPreference = r.degradationPreference;
        await sender.setParameters(p);
      }
      this.snap = { ...this.snap, settings: { ...this.snap.settings, screenPreset: presetId, screenHint: h } };
      this.governor = undefined; // the ladder is rebuilt from the new top bitrate on the next stats tick
      this.emit();
      return true;
    } catch { return false; }
  }

  /** Clarity vs smoothness, live. Applies the encoder's degradation preference to the running share. */
  async setScreenDegradation(choice: DegradationChoice) {
    this.snap = { ...this.snap, settings: { ...this.snap.settings, screenDegradation: choice } };
    const t = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined;
    if (t) await this.setLiveStreamQuality(this.snap.settings.screenPreset);
    else this.emit();
  }
  /** Lock the share to a resolution / fps / bitrate (null unlocks). A locked share is not stepped down by the governor; slow viewers get a lower simulcast layer. */
  async setScreenLock(lock: QualityLock | null) {
    const l = normalizeLock(lock);
    this.snap = { ...this.snap, settings: { ...this.snap.settings, screenLock: l, ...(l ? { screenPreset: l.preset } : {}) } };
    this.governor = undefined;
    const t = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined;
    if (t) await this.setLiveStreamQuality(this.snap.settings.screenPreset);
    else this.emit();
  }

  /**
   * Adaptive bitrate on top of libwebrtc's estimator, with hysteresis (adaptation.ts): moves the share's bitrate cap along a ladder
   * slowly and only on sustained trouble, so quality stops pumping. Off while the share is locked or not running.
   */
  private governor?: { g: BitrateGovernor; top: number };
  private async adaptScreen(report: { forEach(cb: (s: any) => void): void }) {
    const st = this.snap.settings;
    const track = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined;
    if (!track || st.screenLock || this.nativeSession) { this.governor = undefined; return; }
    const plan = resolveScreenPlan({ preset: st.screenPreset, hint: st.screenHint, degradation: st.screenDegradation, lock: null, codec: this.codecFor(), constraints: mobileConstraints(this.snap.platform) });
    if (!this.governor || this.governor.top !== plan.maxBitrateKbps) this.governor = { g: new BitrateGovernor(bitrateLadder(plan.maxBitrateKbps)), top: plan.maxBitrateKbps };
    const d = this.governor.g.push(parseScreenSignals(report, Date.now()));
    if (!d.changed) return;
    const sender: any = track.sender; if (!sender) return;
    try {
      const p = sender.getParameters();
      for (const enc of p.encodings ?? []) if (!enc.rid || enc.rid === 'f' || (p.encodings?.length ?? 0) === 1) enc.maxBitrate = d.kbps * 1000;
      await sender.setParameters(p);
    } catch { /* best effort: the browser's own estimator still protects the link */ }
  }

  setContentHint(hint: ContentHint) {
    const t = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (t) t.mediaStreamTrack.contentHint = hint;
  }

  /**
   * Go Live audience control for the streamer. With a list, only those participants may subscribe to my screen share (and its
   * audio); camera and microphone stay open to everybody. This is what makes a viewer cap or a kick real at the media level: the
   * app passes the viewers the server accepted (`watching` in the voice states). Pass null to allow everyone again.
   */
  setStreamAudience(identities: Iterable<string> | null) {
    this.audience = identities ? new Set(identities) : null;
    this.applyAudience();
  }
  private applyAudience() {
    if (this.room.state !== ConnectionState.Connected) return;
    const lp = this.room.localParticipant;
    try {
      if (!this.audience) {
        if (this.audienceSent) { lp.setTrackSubscriptionPermissions(true); this.audienceSent = false; }
        return;
      }
      const screen: string[] = [], rest: string[] = [];
      for (const pub of lp.trackPublications.values()) {
        if (!pub.trackSid) continue;
        (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio ? screen : rest).push(pub.trackSid);
      }
      // participants left out of the list get nothing at all, so every remote is listed
      const perms = Array.from(this.room.remoteParticipants.values()).map((p) => ({ participantIdentity: p.identity, allowAll: false, allowedTrackSids: this.audience!.has(p.identity) ? [...rest, ...screen] : rest }));
      lp.setTrackSubscriptionPermissions(false, perms);
      this.audienceSent = true;
    } catch { /* best effort: the server also unsubscribes kicked viewers */ }
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
      this.mutedTick(now);
      this.applyVolumes();
      this.emit();
    }, 100);
  }

  private bindRoom() {
    const r = this.room;
    const touch = () => this.emit();
    r.on(RoomEvent.ParticipantConnected, () => { this.applyAudience(); touch(); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { this.speaking = speakingReducer(this.speaking, { type: 'remove', id: p.identity }); touch(); })
      .on(RoomEvent.TrackMuted, touch).on(RoomEvent.TrackUnmuted, touch)
      .on(RoomEvent.TrackPublished, touch).on(RoomEvent.TrackUnpublished, touch)
      .on(RoomEvent.LocalTrackPublished, () => { this.applyAudience(); touch(); })
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        // stopped while healthy (browser "Stop sharing" button, device unplugged) = the user's intent changed; a drop is not
        const healthy = !this.leaving && this.rc.phase === 'connected' && this.room.state === ConnectionState.Connected;
        if (pub.source === Track.Source.ScreenShare) { if (healthy) this.intent.screen = false; void this.endNativeScreen(false); this.emit({ screenOn: false }); }
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
      .on(RoomEvent.Reconnected, () => { this.rcDispatch({ type: 'connected' }); this.applyVolumes(); this.applyAudience(); this.connPrev = undefined; })
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
