/**
 * Rolling "last N seconds" buffer for a MediaStream (camera or screen share).
 *
 * A MediaRecorder can only produce a playable file from its *start* (the container header is written once), so a plain
 * ring of chunks would be corrupt after the first drop. Instead two recorders run staggered by half a lifetime and are
 * restarted when their lifetime is over: the older one always holds a complete, playable recording of the most recent
 * `lifetime/2 .. lifetime` seconds. Saving flushes it (requestData) without disturbing the buffer.
 */
import { LIMITS } from '@jorcord/shared';
export const CLIP_WINDOWS = [30, 60, 120] as const;
export type ClipWindow = (typeof CLIP_WINDOWS)[number];
/** Default cap of the clips API (LIMITS.maxClipSeconds; the operator can change it with CLIP_MAX_SECONDS, see `setShareMaxSeconds`). */
export const SHARE_MAX_SECONDS = LIMITS.maxClipSeconds;
let shareMax: number = SHARE_MAX_SECONDS;
/** The cap this server enforces on shared clips (from GET /clips/limits once loaded). */
export const getShareMax = (): number => shareMax;
export function setShareMaxSeconds(n: unknown): void { if (typeof n === 'number' && Number.isFinite(n) && n >= 5) shareMax = Math.floor(n); }
/** Bitrate cap so two encoders on a 1080p screen share stay reasonable and a 2-minute buffer stays in memory (~15-30 MB each). */
export const CLIP_VIDEO_BPS = 2_500_000;
export const MIN_CLIP_SECONDS = 2;

export interface RecorderLike {
  state: string; mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null; onerror: ((e: unknown) => void) | null; onstop: (() => void) | null;
  start(timeslice?: number): void; stop(): void; requestData(): void;
}
export interface ClipBufferDeps {
  createRecorder?: (stream: MediaStream, mime: string) => RecorderLike;
  mimes?: string[]; isTypeSupported?: (m: string) => boolean;
  now?: () => number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void;
}

const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function clipRecordingSupported(g: any = globalThis): boolean {
  return typeof g.MediaRecorder === 'function' && typeof g.Blob === 'function';
}
export function pickClipMime(isSupported: (m: string) => boolean, mimes = MIMES): string | null {
  return mimes.find((m) => { try { return isSupported(m); } catch { return false; } }) ?? null;
}
/** Seconds each recorder lives. A window equal to the server cap records 1 s less so the saved clip never exceeds it. */
export const lifetimeFor = (windowSec: number, max: number = shareMax): number => (windowSec <= max ? Math.min(windowSec, max - 1) : windowSec);

interface Slot { rec: RecorderLike; chunks: Blob[]; startedAt: number }
export interface SavedClip { blob: Blob; durationSec: number; mimeType: string; at: number }

export class ClipBuffer {
  private slots: Slot[] = [];
  private timers: unknown[] = [];
  private ended = false;
  private disposed = false;
  readonly mime: string;
  readonly lifetimeMs: number;
  private d: Required<Pick<ClipBufferDeps, 'now' | 'setTimeout' | 'clearTimeout'>> & { createRecorder: NonNullable<ClipBufferDeps['createRecorder']> };

  constructor(private stream: MediaStream, readonly windowSec: number, deps: ClipBufferDeps = {}) {
    const supported = deps.isTypeSupported ?? ((m: string) => (globalThis as any).MediaRecorder?.isTypeSupported?.(m) ?? false);
    const mime = pickClipMime(supported, deps.mimes);
    if (!mime) throw new Error('This browser cannot record clips (no supported WebM encoder).');
    this.mime = mime;
    this.lifetimeMs = lifetimeFor(windowSec) * 1000;
    this.d = {
      now: deps.now ?? Date.now, setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)), clearTimeout: deps.clearTimeout ?? ((h) => clearTimeout(h as any)),
      createRecorder: deps.createRecorder ?? ((s, m) => new MediaRecorder(s, { mimeType: m, videoBitsPerSecond: CLIP_VIDEO_BPS, audioBitsPerSecond: 96_000 }) as unknown as RecorderLike),
    };
    for (const t of stream.getTracks()) t.addEventListener?.('ended', () => { if (stream.getTracks().every((x) => x.readyState === 'ended')) this.end(); });
  }

  start() {
    if (this.disposed || this.slots.length) return;
    this.spawn();
    this.timers.push(this.d.setTimeout(() => { if (!this.ended) this.spawn(); }, this.lifetimeMs / 2)); // second recorder, half a lifetime behind
  }

  private spawn() {
    const rec = this.d.createRecorder(this.stream, this.mime);
    const slot: Slot = { rec, chunks: [], startedAt: this.d.now() };
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) slot.chunks.push(e.data); };
    rec.onerror = () => { this.drop(slot); if (!this.ended && !this.disposed) this.spawn(); };
    this.slots.push(slot);
    rec.start(1000);
    this.timers.push(this.d.setTimeout(() => this.rotate(slot), this.lifetimeMs));
  }

  private rotate(slot: Slot) {
    if (this.disposed || !this.slots.includes(slot)) return;
    this.drop(slot);
    if (!this.ended) this.spawn();
  }

  private drop(slot: Slot) {
    this.slots = this.slots.filter((s) => s !== slot);
    slot.rec.ondataavailable = null; slot.rec.onerror = null;
    try { if (slot.rec.state !== 'inactive') slot.rec.stop(); } catch { /* */ }
    slot.chunks = [];
  }

  /** The source ended (screen share stopped): keep what we have so the last seconds can still be saved. */
  end() {
    if (this.ended) return; this.ended = true; this.endedAt = this.d.now();
    for (const t of this.timers) this.d.clearTimeout(t); this.timers = [];
    for (const s of this.slots) { try { if (s.rec.state === 'recording') s.rec.requestData(); } catch { /* */ } }
  }
  get isEnded() { return this.ended; }

  /** Seconds currently available (what Save would produce). */
  availableSec(): number {
    const s = this.oldest(); if (!s) return 0;
    return Math.min(this.windowSec, ((this.ended ? this.endedAt ?? this.d.now() : this.d.now()) - s.startedAt) / 1000);
  }
  private endedAt: number | undefined;
  private oldest(): Slot | undefined { return this.slots.reduce<Slot | undefined>((a, s) => (!a || s.startedAt < a.startedAt ? s : a), undefined); }

  /** Cuts a clip from the older recorder: everything it has recorded so far (at most `windowSec`). */
  async save(): Promise<SavedClip> {
    const slot = this.oldest();
    if (!slot) throw new Error('Nothing recorded yet.');
    const at = this.ended && this.endedAt ? this.endedAt : this.d.now();
    const durationSec = Math.min(this.windowSec, (at - slot.startedAt) / 1000);
    if (durationSec < MIN_CLIP_SECONDS) throw new Error('Keep recording for a couple of seconds first.');
    if (slot.rec.state === 'recording') {
      await new Promise<void>((res) => {
        const prev = slot.rec.ondataavailable;
        slot.rec.ondataavailable = (e) => { prev?.(e); slot.rec.ondataavailable = prev; res(); };
        try { slot.rec.requestData(); } catch { res(); }
        this.d.setTimeout(res, 1500); // a recorder that never answers must not hang the UI
      });
    }
    if (!slot.chunks.length) throw new Error('No video data was captured.');
    return { blob: new Blob(slot.chunks, { type: this.mime.split(';')[0] }), durationSec, mimeType: this.mime.split(';')[0]!, at };
  }

  dispose() {
    if (this.disposed) return; this.disposed = true; this.ended = true;
    for (const t of this.timers) this.d.clearTimeout(t); this.timers = [];
    for (const s of [...this.slots]) this.drop(s);
    this.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* clones only */ } });
  }
}

/** Duration to claim when sharing: whole seconds, never above the API limit. */
export const shareDurationSeconds = (durationSec: number, max: number = shareMax): number => Math.min(max, Math.max(1, Math.ceil(durationSec)));
export const canShareClip = (durationSec: number, max: number = shareMax): boolean => durationSec <= max + 0.01;
