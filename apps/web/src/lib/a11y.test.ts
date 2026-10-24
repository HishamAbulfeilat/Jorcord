import { describe, expect, it } from 'vitest';
import { applyA11y, contrastRatio, ensureContrast, safeRoleColor, statusColors, CVD_STATUS_COLORS } from './a11y';

describe('accessibility helpers', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
  it('clamps low-contrast role colours to 4.5:1 on dark and light backgrounds', () => {
    for (const [c, bg] of [['#2c2f33', '#313338'], ['#5865f2', '#313338'], ['#ffffa0', '#ffffff'], ['#101010', '#000000']] as const) {
      const out = ensureContrast(c, bg);
      expect(contrastRatio(out, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ensureContrast('#ffffff', '#313338')).toBe('#ffffff'); // already fine: untouched
    expect(ensureContrast('not-a-colour', '#313338')).toBe('not-a-colour');
  });
  it('safeRoleColor is the identity until the option is enabled', () => {
    const root = document.documentElement;
    applyA11y(root, { dyslexiaFont: false, colorBlindMode: 'off', saturation: 1, roleContrast: false, theme: 'dark' });
    expect(safeRoleColor('#2c2f33')).toBe('#2c2f33');
    applyA11y(root, { dyslexiaFont: false, colorBlindMode: 'off', saturation: 1, roleContrast: true, theme: 'dark' });
    expect(contrastRatio(safeRoleColor('#2c2f33'), '#313338')).toBeGreaterThanOrEqual(4.5);
    applyA11y(root, { dyslexiaFont: false, colorBlindMode: 'off', saturation: 1, roleContrast: false, theme: 'dark' });
  });
  it('colour-blind palettes differ between online / idle / dnd and are applied to the status table', () => {
    for (const m of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const p = CVD_STATUS_COLORS[m];
      expect(new Set([p.online, p.idle, p.dnd]).size).toBe(3);
    }
    const table: Record<string, string> = {};
    applyA11y(document.documentElement, { dyslexiaFont: false, colorBlindMode: 'deuteranopia', saturation: 0.5, roleContrast: false, theme: 'dark' }, table);
    expect(table.online).toBe(statusColors('deuteranopia').online);
    expect(document.documentElement.dataset.cvd).toBe('deuteranopia');
    expect(document.documentElement.style.getPropertyValue('--saturation')).toBe('0.5');
    applyA11y(document.documentElement, { dyslexiaFont: false, colorBlindMode: 'off', saturation: 1, roleContrast: false, theme: 'dark' }, table);
    expect(document.documentElement.dataset.cvd).toBeUndefined();
    expect(table.online).toBe('#23a559');
  });
});
