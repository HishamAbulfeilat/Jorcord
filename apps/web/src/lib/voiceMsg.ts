/**
 * Pure helpers for Discord-style voice messages: mime picking, waveforms and durations.
 * Recording itself lives in voiceRecord.ts; rendering lives in the VoicePlayer waveform component.
 */
export const VOICE_MAX_MS = 10 * 60 * 1000;
export const VOICE_SAMPLE_INTERVAL = 100;
export const VOICE_BARS = 40;

/** Preferred encodings, best first. Bare `audio/webm` matters: it is what the server serves inline. */
export const VOICE_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const;

export function pickVoiceMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of VOICE_MIMES) {
    try { if (MediaRecorder.isTypeSupported?.(m)) return m; } catch { /* ignore */ }
  }
  return null;
}

/** Strip the codecs parameter: `audio/webm;codecs=opus` -> `audio/webm`. */
export function baseMime(mime: string | undefined): string {
  const base = (mime ?? '').split(';')[0]!.trim();
  return base.startsWith('audio/') ? base : 'audio/webm';
}

/** Discord-style name: voice-message-2026-10-17-1425.webm */
export function voiceFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `voice-message-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.webm`;
}

/** m:ss — 95 -> "1:35"; round half seconds up so recordings never show 0:00 for non-empty audio. */
export function fmtVoiceDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Max absolute amplitude per bar. Peaks are kept raw; the renderer normalizes for display. */
export function waveformPeaks(samples: ArrayLike<number>, bars = VOICE_BARS): number[] {
  const out = new Array<number>(bars).fill(0);
  if (bars <= 0 || !samples || !samples.length) return out;
  const size = samples.length / bars;
  for (let b = 0; b < bars; b++) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((b + 1) * size)));
    let peak = 0;
    for (let i = start; i < end; i++) { const v = Math.abs(Number(samples[i])); if (v > peak) peak = v; }
    out[b] = peak;
  }
  return out;
}
