/**
 * Tiny i18n layer. Source strings ARE the English text: `t('Cancel')`. Other locales map English -> translation;
 * a missing entry falls back to English. `{name}` placeholders are replaced from the vars object.
 * Only UI chrome is translated: user-written messages are never touched.
 */
import es from './es';
import fr from './fr';
import de from './de';
import tr from './tr';
import ar from './ar';
import pt from './pt';
import ru from './ru';
import hi from './hi';
import id from './id';
import ja from './ja';
import zh from './zh';
import ko from './ko';
import it from './it';
import nl from './nl';
import pl from './pl';

export type Dict = Record<string, string>;
export const LOCALES = [
  { id: 'en', tag: 'en-US', label: 'English (US)', dir: 'ltr' as const },
  { id: 'en', tag: 'en-GB', label: 'English (UK)', dir: 'ltr' as const },
  { id: 'es', tag: 'es-ES', label: 'Español', dir: 'ltr' as const },
  { id: 'fr', tag: 'fr-FR', label: 'Français', dir: 'ltr' as const },
  { id: 'de', tag: 'de-DE', label: 'Deutsch', dir: 'ltr' as const },
  { id: 'tr', tag: 'tr-TR', label: 'Türkçe', dir: 'ltr' as const },
  { id: 'ar', tag: 'ar', label: 'العربية', dir: 'rtl' as const },
  { id: 'pt', tag: 'pt-BR', label: 'Português (Brasil)', dir: 'ltr' as const },
  { id: 'ru', tag: 'ru-RU', label: 'Русский', dir: 'ltr' as const },
  { id: 'hi', tag: 'hi-IN', label: 'हिन्दी', dir: 'ltr' as const },
  { id: 'id', tag: 'id-ID', label: 'Bahasa Indonesia', dir: 'ltr' as const },
  { id: 'ja', tag: 'ja-JP', label: '日本語', dir: 'ltr' as const },
  { id: 'zh', tag: 'zh-CN', label: '简体中文', dir: 'ltr' as const },
  { id: 'ko', tag: 'ko-KR', label: '한국어', dir: 'ltr' as const },
  { id: 'it', tag: 'it-IT', label: 'Italiano', dir: 'ltr' as const },
  { id: 'nl', tag: 'nl-NL', label: 'Nederlands', dir: 'ltr' as const },
  { id: 'pl', tag: 'pl-PL', label: 'Polski', dir: 'ltr' as const },
] as const;
export const DICTS: Record<string, Dict> = { es, fr, de, tr, ar, pt, ru, hi, id, ja, zh, ko, it, nl, pl };
export const TRANSLATED = Object.keys(DICTS);

/** 'es-ES' | 'es' | 'ar-EG' -> 'es' | 'ar'; unknown -> 'en'. */
export function localeId(tag: string | undefined): string {
  const base = (tag ?? 'en').toLowerCase().split('-')[0]!;
  return base in DICTS ? base : 'en';
}
export const isRtlLang = (tag: string | undefined) => localeId(tag) === 'ar';

let current = 'en';
let currentTag = 'en-US';

/** Silent (render-safe) locale switch: sets <html lang/dir>. The app root is keyed by language, so the tree remounts with the new strings. */
export function setLocale(tag: string) {
  currentTag = tag || 'en-US'; current = localeId(tag);
  if (typeof document !== 'undefined') {
    const r = document.documentElement; r.lang = currentTag; r.dir = isRtlLang(tag) ? 'rtl' : 'ltr';
  }
}
export const getLocaleTag = () => currentTag;
export const getLocale = () => current;

export function translate(lang: string, key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[lang]?.[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}
/** Marks a string for extraction without translating it now (module-level tables; translate with t() at render time). */
export const T = (s: string) => s;
export const t = (key: string, vars?: Record<string, string | number>) => translate(current, key, vars);

/** Plural helper over two source strings: `tn(n, '{n} member', '{n} members')`. */
export const tn = (n: number, one: string, other: string) => t(n === 1 ? one : other, { n });

/** Hook form for components (the tree is keyed by language, so no subscription is needed). */
export const useT = () => t;
