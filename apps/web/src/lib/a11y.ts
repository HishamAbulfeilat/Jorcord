/**
 * Accessibility options beyond reduced motion / contrast:
 *  - dyslexia-friendly font (OpenDyslexic, SIL OFL, bundled via @fontsource and loaded lazily, never from a CDN)
 *  - colour-blind safe status palettes (Okabe-Ito based); presence dots also differ by SHAPE (moon, minus, hollow ring), never by colour alone
 *  - saturation slider (0-100 %)
 *  - role colours clamped to a 4.5:1 contrast ratio against the theme background
 */
export type ColorBlindMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export const COLOR_BLIND_MODES: { id: ColorBlindMode; label: string }[] = [
  { id: 'off', label: 'Off' }, { id: 'protanopia', label: 'Protanopia (red-weak)' }, { id: 'deuteranopia', label: 'Deuteranopia (green-weak)' }, { id: 'tritanopia', label: 'Tritanopia (blue-weak)' },
];

type Status = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';
export const DEFAULT_STATUS_COLORS: Record<Status, string> = { online: '#23a559', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e', invisible: '#80848e' };
/** Distinguishable under each deficiency (blue / orange / vermillion family from the Okabe-Ito set). */
export const CVD_STATUS_COLORS: Record<Exclude<ColorBlindMode, 'off'>, Record<Status, string>> = {
  protanopia: { online: '#0072b2', idle: '#e69f00', dnd: '#d55e00', offline: '#80848e', invisible: '#80848e' },
  deuteranopia: { online: '#0072b2', idle: '#e69f00', dnd: '#cc79a7', offline: '#80848e', invisible: '#80848e' },
  tritanopia: { online: '#009e73', idle: '#f0e442', dnd: '#d55e00', offline: '#80848e', invisible: '#80848e' },
};
export const statusColors = (mode: ColorBlindMode): Record<Status, string> => (mode === 'off' ? DEFAULT_STATUS_COLORS : CVD_STATUS_COLORS[mode]);

// ---- contrast ----
const hexToRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (c: [number, number, number]) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: [number, number, number]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrastRatio(a: string, b: string): number {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 21;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Moves `color` toward white (dark backgrounds) or black (light backgrounds) in small steps until it reaches `min`:1 against `bg`. Unparseable input is returned unchanged. */
export function ensureContrast(color: string, bg: string, min = 4.5): string {
  const c = hexToRgb(color), b = hexToRgb(bg);
  if (!c || !b || contrastRatio(color, bg) >= min) return color;
  const target: [number, number, number] = luminance(b) < 0.4 ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const next = rgbToHex([c[0] + (target[0] - c[0]) * t, c[1] + (target[1] - c[1]) * t, c[2] + (target[2] - c[2]) * t]);
    if (contrastRatio(next, bg) >= min) return next;
  }
  return rgbToHex(target);
}

export const THEME_BG: Record<string, string> = { dark: '#313338', light: '#ffffff', amoled: '#000000' };
let roleBg: string | null = null;
/** Role colour as it should be drawn right now (identity unless the contrast option is on). */
export const safeRoleColor = <T extends string | undefined>(hex: T): T => (hex && roleBg ? (ensureContrast(hex, roleBg) as T) : hex);

export interface A11yPrefs { dyslexiaFont: boolean; colorBlindMode: ColorBlindMode; saturation: number; roleContrast: boolean; theme: string }

/** Applies the options to the document. `statusPalette` is the mutable presence colour table of the Avatar component. */
export function applyA11y(root: HTMLElement, p: A11yPrefs, statusPalette?: Record<string, string>) {
  if (p.dyslexiaFont) {
    root.dataset.font = 'dyslexic';
    void Promise.all([import('@fontsource/opendyslexic/400.css'), import('@fontsource/opendyslexic/700.css')]).catch(() => { /* font is optional */ });
  } else delete root.dataset.font;
  root.style.setProperty('--saturation', String(Math.max(0, Math.min(1, p.saturation))));
  if (p.colorBlindMode !== 'off') root.dataset.cvd = p.colorBlindMode; else delete root.dataset.cvd;
  if (statusPalette) Object.assign(statusPalette, statusColors(p.colorBlindMode));
  roleBg = p.roleContrast ? THEME_BG[p.theme] ?? THEME_BG.dark! : null;
}
