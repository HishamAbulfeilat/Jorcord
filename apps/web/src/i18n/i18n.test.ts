import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DICTS, TRANSLATED, isRtlLang, localeId, setLocale, t, tn, translate } from './index';

const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
const sources = (() => { const out: string[] = []; (function w(d: string) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!p.endsWith('/i18n')) w(p); } else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) out.push(readFileSync(p, 'utf8')); } })(join(__dirname, '..')); return out.join('\n'); })();

describe('i18n', () => {
  it('ships en (source) plus 15 translated locales (10 of them machine translated, see docs/I18N.md)', () => { expect(TRANSLATED.sort()).toEqual(['ar', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'zh']); });
  it('every locale translates the same core keys, none empty, placeholders preserved', () => {
    const base = Object.keys(DICTS.es!);
    expect(base.length).toBeGreaterThan(150);
    for (const l of TRANSLATED) {
      expect(Object.keys(DICTS[l]!).sort()).toEqual([...base].sort());
      for (const k of base) { expect(DICTS[l]![k], `${l}:${k}`).toBeTruthy(); expect(ph(DICTS[l]![k]!), `${l}:${k}`).toBe(ph(k)); }
    }
  });
  it('the main navigation strings used by the UI are in the dictionaries', () => {
    for (const k of ['Servers', 'Direct Messages', 'Channels', 'User Settings', 'My Account', 'Notifications', 'Log Out', 'Go Live', 'Streamer Mode', 'Cancel', 'Save Changes']) {
      expect(sources.includes(`'${k}'`), `source uses ${k}`).toBe(true);
      for (const l of TRANSLATED) expect(DICTS[l]![k], `${l}:${k}`).toBeTruthy();
    }
  });
  it('falls back to English and interpolates', () => {
    expect(translate('es', 'Some brand new string')).toBe('Some brand new string');
    expect(translate('es', 'Welcome to {name}', { name: 'X' })).toBe('Te damos la bienvenida a X');
    setLocale('de-DE'); expect(t('Cancel')).toBe('Abbrechen'); expect(tn(1, '{n} member', '{n} members')).toBe('1 member');
    setLocale('en-US');
  });
  it('arabic is RTL and sets <html dir>', () => {
    expect(isRtlLang('ar')).toBe(true); expect(isRtlLang('ar-EG')).toBe(true); expect(isRtlLang('es-ES')).toBe(false); expect(localeId('tr-TR')).toBe('tr');
    setLocale('ar'); expect(document.documentElement.dir).toBe('rtl'); expect(document.documentElement.lang).toBe('ar'); setLocale('fr-FR'); expect(document.documentElement.dir).toBe('ltr'); setLocale('en-US');
  });
});
