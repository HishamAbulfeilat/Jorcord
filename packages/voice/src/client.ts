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
import { createRnnoiseProcessor } from './noise';
import { createPushToTalk } from './ptt';
import { effectiveVolume } from './priority';
import {
  detectSupportedVideoCodecs, isScalableCodec, pickCodec, recommendBitrateKbps, selectPreset, simulcastLayers,
  viewerQualityToDimensions, type ContentHint, type StreamPresetId, type VideoCodecName, type ViewerQuality,
} from './presets';
import { detectPlatform, mobileConstraints, type Platform } from './mobile';
import { initialSpeaking, speakingReducer, type SpeakingState } from './speaking';
import { parseVideoStats, type StatsSample } from './stats';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type InputMode = 'open' | 'vad' | 'ptt';
export type StreamSource = 'camera' | 'screen';

export interface ParticipantView {
  identity: string; userId: string; name: string; isLocal: boolean;
  speaking: boolean; level: number; micMuted: boolean; cameraOn: boolean; screenOn: boolean; screenAudioOn: boolean;
  quality: NetworkQuality; volume: number; priority: boolean; handRaised: boolean;
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
  screenPreset: StreamPresetId;
  screenHint: Exclude<ContentHint, 'text'> | 'text';
  screenAudio: boolean;
  codec: VideoCodecName | 'auto';
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  audio: DEFAULT_AUDIO, inputMode: 'open', pttCode: 'Backquote', pttReleaseMs: 200, vadThreshold: 0.03,
  cameraPreset: '720p30', screenPreset: '1080p60', screenHint: 'motion', screenAudio: true, codec: 'auto',
};

export interface VoiceSnapshot {
  status: VoiceStatus; error: VoiceError | null; channelId: string | null;
  participants: ParticipantView[]; speaking: SpeakingState;
  muted: boolean; deafened: boolean; cameraOn: boolean; screenOn: boolean; pttActive: boolean;
  networkQuality: NetworkQuality; audioBlocked: boolean; e2ee: boolean; platform: Platform;
  devices: { audioinput: MediaDeviceInfo[]; audiooutput: MediaDeviceInfo[]; videoinput: MediaDeviceInfo[] };
  settings: VoiceSettings; activeCodec: VideoCodecName | null;
}

export interface VoiceClientOptions {
  settings?: Partial<VoiceSettings>;
  /** Provide an E2EE handle from createE2EE() */
  e2ee?: { keyProvider: BaseKeyProvider; worker: Worker };
  /** Called when the signal connection dies permanently so the app can refetch a token. */
  onDisconnected?: (reason: 'client' | 'server' | 'error') => void;
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

  constructor(opts: VoiceClientOptions = {}) {
    this.opts = opts;
    const settings: VoiceSettings = { ...DEFAULT_SETTINGS, ...opts.settings, audio: { ...DEFAULT_AUDIO, ...opts.settings?.audio } };
    const platform = detectPlatform();
    this.supportedCodecs = detectSupportedVideoCodecs();
    const ra = resolveAudio(settings.audio);
    this.room = new Room({
      adaptiveStream: { pauseVideoInBackground: true },
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
      webAudioMix: false, // keep HTMLAudioElement path: required for setSinkId + iOS reliability
      audioCaptureDefaults: { ...ra.capture },
      audioOutput: settings.audio.outputDeviceId ? { deviceId: settings.audio.outputDeviceId } : undefined,
      videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
      publishDefaults: {
        audioPreset: { maxBitrate: ra.publish.audioBitrate },
        dtx: ra.publish.dtx, red: ra.publish.red, forceStereo: ra.publish.forceStereo,
        videoCodec: 'vp9', backupCodec: { codec: 'h264' },
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
    };
    this.bindRoom();
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
  async connect(token: Pick<VoiceToken, 'token' | 'url'>, channelId: string): Promise<void> {
    if (this.room.state !== ConnectionState.Disconnected) await this.disconnect();
    this.emit({ status: 'connecting', error: null, channelId });
    try {
      await this.room.connect(token.url, token.token, { autoSubscribe: true });
    } catch (e) {
      this.emit({ status: 'disconnected' });
      throw this.fail(e, 'connect');
    }
    this.startPolling();
    this.setupPtt();
    this.ensureAudioHost();
    await this.refreshDevices();
    this.emit({ status: 'connected', audioBlocked: !this.room.canPlaybackAudio });
    try { await this.applyMicState(true); } catch (e) { this.fail(e, 'media'); }
  }

  async disconnect(): Promise<void> {
    this.stopPtt?.(); this.stopPtt = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.teardownGate();
    await this.room.disconnect(true);
    this.audioHost?.remove(); this.audioHost = undefined;
    this.speaking = initialSpeaking;
    this.emit({ status: 'idle', channelId: null, cameraOn: false, screenOn: false });
  }

  async dispose() { await this.disconnect(); this.listeners.clear(); }

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
    if (resolveAudio(s).useRnnoise && !this.rnnoiseAttached) {
      const proc = await createRnnoiseProcessor();
      if (proc) { await track.setProcessor(proc); this.rnnoiseAttached = true; }
    } else if (!resolveAudio(s).useRnnoise && this.rnnoiseAttached) {
      await track.stopProcessor?.(); this.rnnoiseAttached = false;
    }
  }

  /** Update audio settings. Restarts the mic capture so constraints are re-applied. */
  async setAudioSettings(patch: Partial<AudioSettings>) {
    const audio = { ...this.snap.settings.audio, ...patch };
    this.snap = { ...this.snap, settings: { ...this.snap.settings, audio } };
    const lp = this.room.localParticipant;
    this.room.options.audioCaptureDefaults = { ...resolveAudio(audio).capture };
    this.room.options.publishDefaults = { ...this.room.options.publishDefaults, ...this.audioPublishDefaults() };
    if (patch.outputDeviceId) await this.setOutputDevice(patch.outputDeviceId);
    if (lp.getTrackPublication(Track.Source.Microphone)) {
      this.rnnoiseAttached = false;
      this.teardownGate();
      await lp.setMicrophoneEnabled(false);
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
  async setCameraDevice(deviceId: string) { await this.room.switchActiveDevice('videoinput', deviceId, true); this.emit(); }
  private async setAudioDeviceState(p: Partial<AudioSettings>) {
    this.snap = { ...this.snap, settings: { ...this.snap.settings, audio: { ...this.snap.settings.audio, ...p } } };
    this.emit();
  }

  /** Per-user volume 0..2 (1 = 100%). Persisted by the app if desired via getUserVolume. */
  setUserVolume(identity: string, volume: number) {
    this.userVolumes.set(identity, Math.max(0, Math.min(2, volume)));
    this.applyVolumes(); this.emit();
  }
  getUserVolume(identity: string) { return this.userVolumes.get(identity) ?? 1; }

  private isPriority(p: Participant) { return p.attributes?.[ATTR_PRIORITY] === '1'; }
  private applyVolumes() {
    const remotes = Array.from(this.room.remoteParticipants.values());
    const prioActive = remotes.some((p) => this.isPriority(p) && p.isSpeaking) ||
      (this.isPriority(this.room.localParticipant) && this.room.localParticipant.isSpeaking);
    const selfIsPriority = this.isPriority(this.room.localParticipant);
    for (const p of remotes) {
      const base = this.snap.deafened ? 0 : this.getUserVolume(p.identity);
      const v = this.snap.deafened ? 0 : effectiveVolume(base, { isPrioritySpeakerActive: prioActive, selfIsPriority, targetIsPriority: this.isPriority(p) });
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(v, Track.Source.ScreenShareAudio);
    }
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

  async setCamera(on: boolean, deviceId?: string) {
    const lp = this.room.localParticipant;
    try {
      if (!on) { await lp.setCameraEnabled(false); this.emit({ cameraOn: false }); return; }
      const { options, resolved, codec } = this.publishOptsFor('camera', this.snap.settings.cameraPreset, 'motion');
      const cap: VideoCaptureOptions = {
        resolution: { width: resolved.width, height: resolved.height, frameRate: resolved.fps },
        ...(deviceId ? { deviceId } : {}),
        ...(this.snap.platform.isMobile ? { facingMode: 'user' as const } : {}),
      };
      await lp.setCameraEnabled(true, cap, options);
      this.emit({ cameraOn: true, activeCodec: codec });
    } catch (e) { this.emit({ cameraOn: !!lp.getTrackPublication(Track.Source.Camera) }); throw this.fail(e, 'media'); }
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
      this.emit({ screenOn: true, activeCodec: codec });
    } catch (e) { this.emit({ screenOn: false }); throw this.fail(e, 'screen'); }
  }
  async stopScreenShare() { await this.room.localParticipant.setScreenShareEnabled(false); this.emit({ screenOn: false }); }

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
        if (pub.source === Track.Source.ScreenShare) this.emit({ screenOn: false });
        if (pub.source === Track.Source.Camera) this.emit({ cameraOn: false });
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
      .on(RoomEvent.Reconnecting, () => this.emit({ status: 'reconnecting' }))
      .on(RoomEvent.SignalReconnecting, () => this.emit({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => { this.emit({ status: 'connected' }); this.applyVolumes(); })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.snap.status === 'idle') return;
        this.emit({ status: 'disconnected' });
        this.opts.onDisconnected?.(reason === undefined || (reason as number) === 1 ? 'client' : 'server');
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
        quality: mapConnectionQuality(p.connectionQuality), volume: local ? 1 : this.getUserVolume(p.identity),
        priority: this.isPriority(p), handRaised: p.attributes?.[ATTR_HAND] === '1',
        canPublish: p.permissions?.canPublish !== false, metadata: p.metadata,
      };
    });
  }
}

export type { RemoteParticipant, LocalParticipant, TrackPublication };
