/**
 * "You are muted" hint: detects someone talking into a muted mic.
 *
 * The decision logic is a pure state machine (`MutedSpeakingDetector`) so it can be unit tested without audio; `MicMonitor` is the
 * thin WebAudio part that turns a MediaStreamTrack into RMS levels. Nothing here is ever published or sent anywhere: the monitor
 * listens to a local clone of the mic and only the fact "speech while muted" leaves it.
 */
export interface MutedSpeakingOptions {
  /** RMS (0..1) above which the mic counts as carrying speech. */
  threshold: number;
  /** Speech must continue for this long (ms, small gaps allowed) before the hint fires: coughs and key clicks do not count. */
  minSpeechMs: number;
  /** A silence longer than this ends the current burst of speech. */
  gapMs: number;
  /** After a hint, stay quiet this long (ms) even if the user keeps talking. */
  cooldownMs: number;
}
export const MUTED_SPEAKING_DEFAULTS: MutedSpeakingOptions = { threshold: 0.04, minSpeechMs: 400, gapMs: 250, cooldownMs: 10_000 };
/** How long the snapshot flag `speakingWhileMuted` stays true after a hint (drives the toast / mic-button indicator). */
export const MUTED_HINT_VISIBLE_MS = 4000;

export class MutedSpeakingDetector {
  private since: number | null = null;
  private lastLoud = 0;
  private lastHint = -Infinity;
  private o: MutedSpeakingOptions;
  constructor(o: Partial<MutedSpeakingOptions> = {}) { this.o = { ...MUTED_SPEAKING_DEFAULTS, ...o }; }

  /** Feed one level sample. Returns true exactly when the hint should be shown now. Not muted resets everything. */
  feed(now: number, rms: number, muted: boolean): boolean {
    if (!muted) { this.since = null; return false; }
    if (rms >= this.o.threshold) {
      if (this.since === null || now - this.lastLoud > this.o.gapMs) this.since = now;
      this.lastLoud = now;
      if (now - this.since >= this.o.minSpeechMs && now - this.lastHint >= this.o.cooldownMs) {
        this.lastHint = now; this.since = null;
        return true;
      }
    } else if (this.since !== null && now - this.lastLoud > this.o.gapMs) this.since = null;
    return false;
  }
  reset() { this.since = null; }
  /** Forget the cooldown (e.g. the user unmuted and muted again). */
  rearm() { this.since = null; this.lastHint = -Infinity; }
}

/** RMS of a time-domain buffer (-1..1). */
export function rmsOf(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

/**
 * Level meter over a private clone of a mic track. The clone is forced `enabled` because LiveKit disables the original while the
 * user is muted, which would make it read silence. `stop()` releases the clone (and the stream it opened itself, if any).
 */
export class MicMonitor {
  private ctx: AudioContext | undefined;
  private analyser: AnalyserNode | undefined;
  private src: MediaStreamAudioSourceNode | undefined;
  private buf: Float32Array<ArrayBuffer> | undefined;
  private owned: MediaStreamTrack[] = [];
  /** Id of the source track the monitor listens to (to notice a replaced mic). */
  sourceId: string | null = null;

  /** Returns false when WebAudio is unavailable. `own` = the track was opened just for the monitor and is stopped with it. */
  start(track: MediaStreamTrack, own = false): boolean {
    this.stop();
    if (typeof AudioContext === 'undefined') { if (own) track.stop(); return false; }
    try {
      const mon = own ? track : track.clone();
      mon.enabled = true;
      this.owned = [mon];
      this.ctx = new AudioContext();
      this.src = this.ctx.createMediaStreamSource(new MediaStream([mon]));
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
      this.sourceId = own ? `own:${mon.id}` : track.id;
      return true;
    } catch { this.stop(); return false; }
  }
  get active() { return !!this.analyser; }
  level(): number {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    return rmsOf(this.buf);
  }
  stop() {
    try { this.src?.disconnect(); } catch { /* noop */ }
    for (const t of this.owned) { try { t.stop(); } catch { /* noop */ } }
    try { void this.ctx?.close(); } catch { /* noop */ }
    this.ctx = undefined; this.analyser = undefined; this.src = undefined; this.buf = undefined; this.owned = []; this.sourceId = null;
  }
}
