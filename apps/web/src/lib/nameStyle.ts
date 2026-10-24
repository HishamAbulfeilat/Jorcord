import { DISPLAY_NAME_EFFECTS, DISPLAY_NAME_FONTS, type DisplayNameStyle } from '@jorcord/shared';

/** CSS classes (cosmetics.css) for a user's free display-name style. Unknown ids from a newer server render plain. */
export function nameStyleClass(s: Partial<DisplayNameStyle> | null | undefined): string {
  if (!s) return '';
  const font = DISPLAY_NAME_FONTS.some((f) => f.id === s.font) && s.font !== 'default' ? `dnf-${s.font}` : '';
  const effect = DISPLAY_NAME_EFFECTS.some((f) => f.id === s.effect) && s.effect !== 'none' ? `dnx-${s.effect}` : '';
  return [font, effect].filter(Boolean).join(' ');
}
