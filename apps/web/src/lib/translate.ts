import { create } from 'zustand';
import { api } from '@/lib/api';

/** Chrome's built-in on-device Translator API (when present). Typed loosely: it is not in lib.dom yet. */
interface BrowserTranslator { translate(text: string): Promise<string> }
interface TranslatorStatic { create(o: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator> }
const browserTranslator = (): TranslatorStatic | null => { const g = globalThis as any; return g.Translator && typeof g.Translator.create === 'function' ? (g.Translator as TranslatorStatic) : null; };
const browserDetector = (): { create(): Promise<{ detect(t: string): Promise<{ detectedLanguage: string; confidence: number }[]> }> } | null => { const g = globalThis as any; return g.LanguageDetector && typeof g.LanguageDetector.create === 'function' ? g.LanguageDetector : null; };

async function serverConfigured(): Promise<boolean> {
  if (serverAvail === null) { try { serverAvail = !!(await api.messages.translateConfig()).available; } catch { serverAvail = false; } }
  return serverAvail;
}
export type TranslateSupport = 'browser' | 'server' | 'none';
let serverAvail: boolean | null = null;
/** 'browser' when the Translator API exists, 'server' when TRANSLATE_URL is configured, otherwise 'none' (the menu item is shown disabled). */
export async function translateSupport(): Promise<TranslateSupport> {
  if (browserTranslator()) return 'browser';
  return (await serverConfigured()) ? 'server' : 'none';
}
/** Translations shown under messages (per message id; 'loading' while in flight). Session only, never stored. */
export const useTranslations = create<{ by: Record<string, TranslateResult | 'loading'>; set(id: string, v: TranslateResult | 'loading' | null): void }>((set) => ({
  by: {},
  set: (id, v) => set((s) => { const by = { ...s.by }; if (v === null) delete by[id]; else by[id] = v; return { by }; }),
}));
/** Sync read of the cached capability (null = not probed yet). */
export const translateSupportCached = (): TranslateSupport | null => (browserTranslator() ? 'browser' : serverAvail === null ? null : serverAvail ? 'server' : 'none');
export const _resetTranslateSupport = () => { serverAvail = null; };

/** Target language: the app language ("pt-BR" stays, since LibreTranslate and Chrome both take BCP-47). */
export const targetLanguage = (lang: string | undefined) => (lang || (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en');

export interface TranslateResult { text: string; via: 'browser' | 'server'; detected?: string | null }

/** Translates one message: on-device first, else the server endpoint. Throws a user-facing Error when neither is available. */
export async function translateMessage(channelId: string, messageId: string, content: string, to: string): Promise<TranslateResult> {
  const T = browserTranslator();
  if (T) {
    let source: string | null = null;
    try { const D = browserDetector(); if (D) { const det = await (await D.create()).detect(content); source = det[0]?.detectedLanguage || null; } } catch { /* no detection: see below */ }
    const target = to.split('-')[0]!;
    if (source && source.split('-')[0] === target) return { text: content, via: 'browser', detected: source };
    // the on-device API needs the source language: without a detector, only a server can auto-detect, so prefer it when there is one
    if (source || (await serverConfigured()) === false) {
      try { const tr = await T.create({ sourceLanguage: source ?? 'en', targetLanguage: target }); return { text: await tr.translate(content), via: 'browser', detected: source }; }
      catch { /* unsupported pair or download blocked: try the server */ }
    }
  }
  if (!(await serverConfigured())) throw new Error('Translation is not available: this browser has no Translator API and the server has no TRANSLATE_URL.');
  const r = await api.messages.translate(channelId, messageId, to);
  return { text: r.text, via: 'server', detected: r.detectedLanguage };
}
