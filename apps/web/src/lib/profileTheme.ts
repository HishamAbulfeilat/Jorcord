/** Profile themes: a user-chosen accent colour drives a gradient header (when there is no banner) and a tinted card. */
export const PROFILE_THEMES = [
  { id: 'blurple', name: 'Blurple', color: '#5865f2' }, { id: 'sunset', name: 'Sunset', color: '#f0552b' }, { id: 'ocean', name: 'Ocean', color: '#1a8fc4' },
  { id: 'forest', name: 'Forest', color: '#2f9e5b' }, { id: 'sakura', name: 'Sakura', color: '#e8579b' }, { id: 'grape', name: 'Grape', color: '#8e44ad' },
  { id: 'gold', name: 'Gold', color: '#d9a21b' }, { id: 'slate', name: 'Slate', color: '#5d6b7a' },
] as const;

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
export function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1]!, 16); const f = (c: number) => clamp(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const profileGradient = (accent: string) => `linear-gradient(135deg, ${accent}, ${shade(accent, -0.45)})`;
/** Background for the whole card body: the modal colour tinted with the accent. */
export const profileTint = (accent: string) => `color-mix(in srgb, ${accent} 16%, rgb(var(--modal-alt)))`;
export const isHex = (v: string | null | undefined): v is string => !!v && /^#[0-9a-f]{6}$/i.test(v);

/** Two-colour profile themes (`User.themeColors`, visible to everyone): a diagonal gradient over the card, tinted body. */
export type ThemePair = [string, string];
export const THEME_PAIRS: { id: string; name: string; colors: ThemePair }[] = [
  { id: 'aurora', name: 'Aurora', colors: ['#5865f2', '#3ba55d'] }, { id: 'dusk', name: 'Dusk', colors: ['#f0552b', '#8e44ad'] }, { id: 'lagoon', name: 'Lagoon', colors: ['#1a8fc4', '#2f9e5b'] },
  { id: 'candy', name: 'Candy', colors: ['#e8579b', '#5865f2'] }, { id: 'ember', name: 'Ember', colors: ['#d9a21b', '#ed4245'] }, { id: 'midnight', name: 'Midnight', colors: ['#2c2f6b', '#8e44ad'] },
];
export const isHexPair = (v: unknown): v is ThemePair => Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
export const themeGradient = ([a, b]: ThemePair) => `linear-gradient(135deg, ${a}, ${b})`;
export const themeTint = ([a, b]: ThemePair) => `linear-gradient(180deg, color-mix(in srgb, ${a} 18%, rgb(var(--modal-alt))), color-mix(in srgb, ${b} 18%, rgb(var(--modal-alt))))`;
/** Header background precedence: banner image > two-colour theme > single accent gradient > fallback colour. */
export function headerBackground(u: { banner?: string | null; themeColors?: unknown; accentColor?: string | null }, bannerUrl: string | null, fallback: string): string {
  if (bannerUrl) return `center/cover url(${bannerUrl})`;
  if (isHexPair(u.themeColors)) return themeGradient(u.themeColors);
  return isHex(u.accentColor) ? profileGradient(u.accentColor) : fallback;
}
/** Card body background: two-colour tint when themed, else the single-accent tint. */
export function bodyBackground(u: { themeColors?: unknown; accentColor?: string | null }): string | undefined {
  if (isHexPair(u.themeColors)) return themeTint(u.themeColors);
  return isHex(u.accentColor) ? profileTint(u.accentColor) : undefined;
}
