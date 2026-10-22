/**
 * Live captions via the browser's Web Speech API. Strictly local to this browser: only MY OWN speech is captioned (the API takes
 * the default microphone; there is no way to feed it other people's audio), nothing is sent to Jorcord or other participants.
 * Note for the UI: in Chromium the recognition itself is performed by the browser vendor's speech service.
 */
export type CaptionState = 'off' | 'listening' | 'unsupported' | 'blocked' | 'error';

export interface RecognizerLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives?: number;
  onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null; onstart?: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
export type RecognizerCtor = new () => RecognizerLike;

export const getRecognizerCtor = (g: any = globalThis): RecognizerCtor | null => g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
export const captionsSupported = (g: any = globalThis): boolean => !!getRecognizerCtor(g);

export interface CaptionLine { id: number; speaker: string; text: string; final: boolean; at: number }

/** Keeps the last few lines; an interim line is replaced by the next result of the same utterance. */
export function reduceCaptions(lines: CaptionLine[], next: { speaker: string; text: string; final: boolean; at: number }, max = 4): CaptionLine[] {
  const text = next.text.trim(); if (!text) return lines;
  const last = lines[lines.length - 1];
  if (last && !last.final && last.speaker === next.speaker) return [...lines.slice(0, -1), { ...last, text, final: next.final, at: next.at }];
  return [...lines, { id: (last?.id ?? 0) + 1, speaker: next.speaker, text, final: next.final, at: next.at }].slice(-max);
}
/** Drop lines that finished more than `ttlMs` ago so the overlay clears itself in silence. */
export const pruneCaptions = (lines: CaptionLine[], now: number, ttlMs = 7000): CaptionLine[] => {
  const keep = lines.filter((l) => !l.final || now - l.at < ttlMs);
  return keep.length === lines.length ? lines : keep;
};

export interface CaptionEngineOpts {
  ctor: RecognizerCtor | null; lang: string;
  onText(t: { text: string; final: boolean }): void; onState(s: CaptionState): void;
  /** Test seam. */
  setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void;
}

/** Wraps one recognizer: continuous, interim results, auto-restart (Chromium ends the session after a pause) with backoff, honest states. */
export class CaptionEngine {
  private rec: RecognizerLike | null = null;
  private running = false; private restarts = 0; private timer: unknown;
  constructor(private o: CaptionEngineOpts) {}

  start(): CaptionState {
    if (this.running) return 'listening';
    if (!this.o.ctor) { this.o.onState('unsupported'); return 'unsupported'; }
    this.running = true; this.restarts = 0; this.spawn();
    return 'listening';
  }

  private spawn() {
    if (!this.running || !this.o.ctor) return;
    let rec: RecognizerLike;
    try { rec = new this.o.ctor(); } catch { this.running = false; this.o.onState('error'); return; }
    rec.lang = this.o.lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      this.restarts = 0;
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const r = e.results[i]; const alt = r?.[0]; if (!alt) continue;
        this.o.onText({ text: String(alt.transcript ?? ''), final: !!r.isFinal });
      }
    };
    rec.onerror = (e) => {
      const err = String(e?.error ?? '');
      if (err === 'no-speech' || err === 'aborted') return; // normal; onend restarts
      if (err === 'not-allowed' || err === 'service-not-allowed') { this.running = false; this.o.onState('blocked'); return; }
      if (err === 'audio-capture' || err === 'language-not-supported') { this.running = false; this.o.onState('error'); return; }
      // network & friends: retry with backoff (onend follows)
    };
    rec.onend = () => {
      if (!this.running) return;
      if (++this.restarts > 8) { this.running = false; this.o.onState('error'); return; }
      const wait = Math.min(5000, 250 * 2 ** Math.min(this.restarts, 5));
      this.timer = (this.o.setTimeout ?? setTimeout)(() => this.spawn(), this.restarts <= 1 ? 0 : wait);
    };
    this.rec = rec;
    try { rec.start(); this.o.onState('listening'); } catch { this.running = false; this.o.onState('error'); }
  }

  stop() {
    this.running = false; (this.o.clearTimeout ?? clearTimeout)(this.timer as any);
    const r = this.rec; this.rec = null;
    if (r) { r.onresult = r.onerror = r.onend = null; try { r.abort(); } catch { /* */ } }
    this.o.onState('off');
  }
  get isRunning() { return this.running; }
}
