import { MessageFlags } from '@jorcord/shared';

export interface ParsedSend {
  content: string;
  /** Message flags to send (SUPPRESS_NOTIFICATIONS for @silent, SUPPRESS_EMBEDS, TTS). */
  flags: number;
  /** `/tts` was typed but the sender cannot use it (no SEND_TTS): the caller shows an error instead of sending. */
  ttsDenied?: boolean;
  /** `/tts` with no text. */
  ttsEmpty?: boolean;
}

/**
 * Applies the composer's send options and typed shortcuts to the raw text.
 * - A leading `@silent ` token is stripped and sets SUPPRESS_NOTIFICATIONS (1<<12).
 * - `/tts text` is a built-in (not an application command) that sends `text` with the TTS flag (1<<4), only when `canTts`.
 * - `silent` / `noEmbeds` are the composer toggles.
 * Order: `@silent` may come before `/tts` ("@silent /tts hi").
 */
export function parseSendOptions(raw: string, o: { silent?: boolean; noEmbeds?: boolean; canTts?: boolean } = {}): ParsedSend {
  let content = raw; let flags = 0;
  const sil = /^\s*@silent(?:\s+|$)/i.exec(content);
  if (sil) { content = content.slice(sil[0].length); flags |= MessageFlags.SUPPRESS_NOTIFICATIONS; }
  const tts = /^\/tts(?:\s+|$)/i.exec(content.trimStart());
  let ttsDenied = false, ttsEmpty = false;
  if (tts) {
    const rest = content.trimStart().slice(tts[0].length).trim();
    if (!rest) ttsEmpty = true;
    else if (!o.canTts) ttsDenied = true;
    else { content = rest; flags |= MessageFlags.TTS; }
  }
  if (o.silent) flags |= MessageFlags.SUPPRESS_NOTIFICATIONS;
  if (o.noEmbeds) flags |= MessageFlags.SUPPRESS_EMBEDS;
  return { content: content.trim(), flags, ...(ttsDenied ? { ttsDenied } : {}), ...(ttsEmpty ? { ttsEmpty } : {}) };
}

/** True when the text starts a `/tts` command (so the slash-command picker should not claim it). */
export const isTtsCommand = (text: string) => /^\/tts(?:\s|$)/i.test(text);
