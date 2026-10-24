import { ApiError } from '../errors';
import { safePost } from '../lib/safepost';
import type { Ctx } from '../ctx';

const TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 2000;
const cache = new Map<string, { at: number; text: string; detected: string | null }>();

export const translateConfigured = (ctx: Ctx) => !!ctx.config.translateUrl;
/** BCP-47-ish language code accepted by LibreTranslate ("en", "pt-BR", "zh-Hans"). */
export const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * Translates `text` into `to` through the operator's LibreTranslate-compatible endpoint (TRANSLATE_URL).
 * SSRF-safe POST (the operator-set URL may be on a private network, so private addresses are allowed here: it is trusted config, never user input).
 * Results are cached per (message, language) for 24h; `key` is that pair, `text` is only sent on a miss.
 */
export async function translateText(ctx: Ctx, key: string, text: string, to: string): Promise<{ text: string; detected: string | null; cached: boolean }> {
  if (!ctx.config.translateUrl) throw new ApiError(501, 'NOT_CONFIGURED', 'Translation is not configured on this server');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { text: hit.text, detected: hit.detected, cached: true };
  let res;
  try {
    const base = ctx.config.translateUrl.replace(/\/+$/, '');
    const url = /\/translate$/.test(base) ? base : `${base}/translate`;
    res = await safePost(url, JSON.stringify({ q: text, source: 'auto', target: to, format: 'text', ...(ctx.config.translateApiKey ? { api_key: ctx.config.translateApiKey } : {}) }), {}, { timeoutMs: 10_000, allowPrivate: true });
  } catch { throw new ApiError(502, 'TRANSLATE_FAILED', 'The translation service could not be reached'); }
  let json: any = null; try { json = JSON.parse(res.body); } catch { /* handled below */ }
  if (res.status < 200 || res.status >= 300 || typeof json?.translatedText !== 'string') throw new ApiError(502, 'TRANSLATE_FAILED', 'The translation service rejected the request');
  const out = { text: json.translatedText.slice(0, 8000), detected: typeof json.detectedLanguage?.language === 'string' ? json.detectedLanguage.language : null };
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), ...out });
  return { ...out, cached: false };
}
export const _clearTranslateCache = () => cache.clear();
