/**
 * MediaRecorder wrapper for voice messages: samples waveform peaks while recording,
 * caps at 10 minutes and hands back a File whose type is the bare container mime
 * (so the server keeps serving it inline).
 */
import { VOICE_MAX_MS, VOICE_SAMPLE_INTERVAL, voiceFilename } from './voiceMsg';
import { baseMime, pickVoiceMime } from './voiceMsg';

export interface VoiceRecording { file: File; peaks: number[]; durationSec: number }
export type VoiceTick = (peaks: number[], elapsedMs: number) => void;

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Uint8Array<ArrayBuffer> | null = null;
  private chunks: Blob[] = [];
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private peaks: number[] = [];
  private startedAt = 0;

  constructor(private onTick?: VoiceTick) {}

  get active() { return this.recorder?.state === 'recording'; }

  async start() {
    if (this.active) return;
    this.stopped = false;
    this.chunks = []; this.peaks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickVoiceMime() ?? '';
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.addEventListener('dataavailable', (e) => { const b = (e as BlobEvent).data; if (b && b.size) this.chunks.push(b); });
    this.startedAt = Date.now();
    this.recorder.start();

    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analyser = an;
      this.buf = new Uint8Array(an.fftSize);
    } catch { this.analyser = null; } // no analyser is fine: the waveform just stays flat

    this.timer = setInterval(() => this.tick(), VOICE_SAMPLE_INTERVAL);
    this.capTimer = setTimeout(() => { void this.stop(); }, VOICE_MAX_MS);
  }

  private tick() {
    if (this.stopped) return;
    const an = this.analyser, buf = this.buf;
    let peak = 0;
    if (an && buf) {
      an.getByteTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]! - 128) / 128; if (v > peak) peak = v; }
    }
    this.peaks.push(peak);
    this.onTick?.(this.peaks, Date.now() - this.startedAt);
  }

  /** Finish recording and return the take, or null when nothing usable was captured. Tears everything down. */
  async stop(): Promise<VoiceRecording | null> {
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      this.stopped = true;
      const done = new Promise<void>((res) => rec.addEventListener('stop', () => res(), { once: true }));
      rec.stop();
      await done;
    }
    const take = this.compose();
    this.teardown();
    return take;
  }

  /** Throw the take away. */
  cancel() { this.teardown(); }

  private compose(): VoiceRecording | null {
    const mime = baseMime(this.recorder?.mimeType ?? this.chunks[0]?.type ?? 'audio/webm');
    const blob = new Blob(this.chunks, { type: mime });
    if (!blob.size) return null;
    const durationSec = Math.max(0, (Date.now() - this.startedAt) / 1000);
    return { file: new File([blob], voiceFilename(), { type: mime }), peaks: [...this.peaks], durationSec };
  }

  private teardown() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.capTimer) { clearTimeout(this.capTimer); this.capTimer = null; }
    this.analyser = null; this.buf = null;
    void this.ctx?.close().catch(() => {}); this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    const rec = this.recorder; this.recorder = null;
    if (rec && rec.state !== 'inactive') rec.stop();
    this.chunks = []; this.peaks = []; // no second take out of the same recorder
  }
}
