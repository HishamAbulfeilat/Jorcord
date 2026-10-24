import { MessageFlags } from '@jorcord/shared';

export interface TtsDecision { flags: number; mine: boolean; allowed: boolean; inCall: boolean }
/** Whether an incoming message should be read aloud: it carries the TTS flag, the receiver opted in, it is not their own message and they are not in a call. */
export const shouldSpeak = (d: TtsDecision): boolean => (d.flags & MessageFlags.TTS) !== 0 && d.allowed && !d.mine && !d.inCall;

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** At most this many queued utterances, so a flood of /tts messages cannot talk for minutes. */
const MAX_QUEUE = 3;
let queued = 0;
/** Speaks `text` with the Web Speech API. Returns false when unsupported or the queue is full. */
export function speak(text: string, lang?: string): boolean {
  const t = text.trim().slice(0, 400);
  if (!t || !ttsSupported() || queued >= MAX_QUEUE) return false;
  const u = new SpeechSynthesisUtterance(t); if (lang) u.lang = lang;
  const done = () => { queued = Math.max(0, queued - 1); };
  u.onend = done; u.onerror = done; queued++;
  try { window.speechSynthesis.speak(u); } catch { done(); return false; }
  return true;
}
