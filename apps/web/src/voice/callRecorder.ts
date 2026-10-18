/**
 * Call recording: mixes every participant's audio through Web Audio into one MediaRecorder stream and,
 * in video mode, adds the active screen share. The local recorder owns only the synthetic output tracks;
 * participant tracks (microphone / screen share) are never stopped.
 */
import { LIMITS } from '@jorcord/shared';
import { VOICE_MIMES } from '@/lib/voiceMsg';

export const CALL_RECORDING_MAX_MS = 2 * 60 * 60 * 1000;
export const CALL_RECORDING_MAX_BYTES = LIMITS.maxUploadBytes;
export type CallRecordingLimit = 'time' | 'size';

const VIDEO_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

interface TrackPublicationLike { source?: string; track?: { mediaStreamTrack?: MediaStreamTrack } | null }
interface ParticipantLike { trackPublications?: Map<string, TrackPublicationLike> }
export interface RecordingRoom {
  localParticipant?: ParticipantLike;
  remoteParticipants?: Map<string, ParticipantLike>;
}

/** Best container the browser can actually encode, or null to let MediaRecorder choose. */
export function pickRecordingMime(video: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of video ? VIDEO_MIMES : VOICE_MIMES) {
    try { if (MediaRecorder.isTypeSupported?.(m)) return m; } catch { /* ignore */ }
  }
  return null;
}

/** call-recording-2026-10-18-1200.webm — the bare container keeps the file inline-playable. */
export function recordingFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `call-recording-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.webm`;
}

/** m:ss, or h:mm:ss once the recording passes an hour. */
export function fmtRecordingDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function participants(room: RecordingRoom): ParticipantLike[] {
  return [room.localParticipant, ...(room.remoteParticipants?.values() ?? [])].filter(Boolean) as ParticipantLike[];
}

function publications(p: ParticipantLike): TrackPublicationLike[] {
  return p.trackPublications ? [...p.trackPublications.values()] : [];
}

function audioTracks(room: RecordingRoom): MediaStreamTrack[] {
  const out: MediaStreamTrack[] = [];
  for (const p of participants(room)) for (const pub of publications(p)) {
    const track = pub.track?.mediaStreamTrack;
    if (track && (pub.source === 'microphone' || pub.source === 'screen_share_audio')) out.push(track);
  }
  return out;
}

function screenShareTrack(room: RecordingRoom): MediaStreamTrack | null {
  for (const p of participants(room)) for (const pub of publications(p)) {
    const track = pub.track?.mediaStreamTrack;
    if (track && pub.source === 'screen_share') return track;
  }
  return null;
}

function baseMime(mime: string | undefined, video: boolean): string {
  const base = (mime ?? '').split(';')[0]!.trim();
  if (base.startsWith('audio/') || base.startsWith('video/')) return base;
  return video ? 'video/webm' : 'audio/webm';
}

export interface CallRecorderOptions {
  maxMs?: number;
  maxBytes?: number;
  /** Fired once when the time or size cap is reached; the caller stops and uploads the take. */
  onLimit?: (reason: CallRecordingLimit) => void;
}

export class CallRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private ctx: AudioContext | null = null;
  private sources: AudioNode[] = [];
  private ownTracks: MediaStreamTrack[] = [];
  private chunks: Blob[] = [];
  private bytes = 0;
  private stopped = false;
  private limitFired = false;
  private timeTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAtValue = 0;
  private readonly maxMs: number;
  private readonly maxBytes: number;

  constructor(private opts: CallRecorderOptions = {}) {
    this.maxMs = opts.maxMs ?? CALL_RECORDING_MAX_MS;
    this.maxBytes = opts.maxBytes ?? CALL_RECORDING_MAX_BYTES;
  }

  get active() { return this.recorder?.state === 'recording'; }
  get startedAt() { return this.startedAtValue; }

  async start(room: RecordingRoom, opts: { video: boolean }): Promise<void> {
    if (this.active) return;
    this.stopped = false; this.limitFired = false;
    this.chunks = []; this.bytes = 0;

    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error('Audio recording is not supported in this browser.');
    const ctx = new AC();
    this.ctx = ctx;
    try { await ctx.resume?.(); } catch { /* already running / not required */ }

    try {
      const dest = ctx.createMediaStreamDestination();
      this.destination = dest;
      this.ownTracks = [...dest.stream.getAudioTracks()];
      for (const track of audioTracks(room)) {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        source.connect(dest);
        this.sources.push(source);
      }

      let stream = dest.stream;
      if (opts.video) {
        const video = screenShareTrack(room);
        if (!video) throw new Error('There is no active screen share to record.');
        stream = new MediaStream([...dest.stream.getAudioTracks(), video]);
      }
      this.stream = stream;

      const mime = pickRecordingMime(opts.video) ?? '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      this.recorder = rec;
      rec.addEventListener('dataavailable', (e) => {
        const blob = (e as BlobEvent).data;
        if (!blob?.size) return;
        this.chunks.push(blob);
        this.bytes += blob.size;
        if (this.bytes > this.maxBytes) this.hitLimit('size');
      });
      this.startedAtValue = Date.now();
      // A timeslice makes dataavailable fire while recording, so the size cap can stop us before upload.
      rec.start(1000);
      this.timeTimer = setTimeout(() => this.hitLimit('time'), this.maxMs);
    } catch (e) {
      this.teardown();
      throw e;
    }
  }

  /** Finish and return the take (dropping trailing chunks that would exceed the size cap), or null. */
  async stop(): Promise<File | null> {
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      this.stopped = true;
      const done = new Promise<void>((res) => rec.addEventListener('stop', () => res(), { once: true }));
      rec.stop();
      await done;
    }
    const file = this.compose();
    this.teardown();
    return file;
  }

  cancel() { this.teardown(); }

  private hitLimit(reason: CallRecordingLimit) {
    if (this.limitFired || this.stopped) return;
    this.limitFired = true;
    if (this.opts.onLimit) this.opts.onLimit(reason);
    else void this.stop();
  }

  private compose(): File | null {
    const video = !!this.stream?.getVideoTracks?.().length;
    const type = baseMime(this.recorder?.mimeType ?? this.chunks[0]?.type, video);
    const kept: Blob[] = [];
    let total = 0;
    for (const chunk of this.chunks) {
      if (total + chunk.size > this.maxBytes) break;
      kept.push(chunk); total += chunk.size;
    }
    const blob = new Blob(kept, { type });
    if (!blob.size) return null;
    return new File([blob], recordingFilename(), { type });
  }

  private teardown() {
    this.stopped = true;
    if (this.timeTimer) { clearTimeout(this.timeTimer); this.timeTimer = null; }
    for (const source of this.sources) { try { source.disconnect(); } catch { /* already gone */ } }
    this.sources = [];
    this.destination = null;
    try { void this.ctx?.close?.(); } catch { /* ignore */ }
    this.ctx = null;
    // Only the synthetic output tracks belong to us; never stop a participant's microphone/screen track.
    for (const track of this.ownTracks) { try { track.stop(); } catch { /* ignore */ } }
    this.ownTracks = [];
    this.stream = null;
    const rec = this.recorder; this.recorder = null;
    if (rec && rec.state !== 'inactive') rec.stop();
    this.chunks = []; this.bytes = 0;
  }
}
