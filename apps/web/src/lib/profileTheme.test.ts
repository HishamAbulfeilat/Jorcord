import { describe, expect, it } from 'vitest';
import { PROFILE_THEMES, isHex, profileGradient, shade } from './profileTheme';
import { maskEmail } from './streamer';

describe('profile themes', () => {
  it('all presets are valid hex colours accepted by the server (#rrggbb)', () => { for (const t of PROFILE_THEMES) expect(t.color).toMatch(/^#[0-9a-f]{6}$/); });
  it('shade darkens and lightens within range', () => {
    expect(shade('#808080', -0.5)).toBe('#404040'); expect(shade('#000000', 1)).toBe('#ffffff'); expect(shade('nope', 0.2)).toBe('nope');
  });
  it('builds a gradient from the accent', () => { expect(profileGradient('#5865f2')).toMatch(/^linear-gradient\(135deg, #5865f2, #[0-9a-f]{6}\)$/); expect(isHex('#abc')).toBe(false); });
  it('masks emails for streamer mode', () => { expect(maskEmail('alice@example.com')).toBe('a••••@example.com'); expect(maskEmail('weird')).toBe('••••••'); });
});

import { THEME_PAIRS, bodyBackground, headerBackground, isHexPair, themeGradient, themeTint } from './profileTheme';
describe('two-colour themes', () => {
  it('presets are valid pairs the server accepts', () => { for (const p of THEME_PAIRS) { expect(isHexPair(p.colors)).toBe(true); expect(p.colors[0]).not.toBe(p.colors[1]); } });
  it('validates pairs strictly', () => { expect(isHexPair(['#112233', '#445566'])).toBe(true); expect(isHexPair(['#123', '#445566'])).toBe(false); expect(isHexPair(['#112233'])).toBe(false); expect(isHexPair(null)).toBe(false); expect(isHexPair('#112233,#445566')).toBe(false); });
  it('builds the gradient and tint from both colours', () => { expect(themeGradient(['#112233', '#445566'])).toBe('linear-gradient(135deg, #112233, #445566)'); const t = themeTint(['#112233', '#445566']); expect(t).toContain('#112233'); expect(t).toContain('#445566'); });
  it('header precedence: banner image > two-colour theme > accent gradient > fallback', () => {
    const pair = ['#112233', '#445566']; expect(headerBackground({ themeColors: pair, accentColor: '#abcdef' }, 'http://x/b.png', 'red')).toBe('center/cover url(http://x/b.png)');
    expect(headerBackground({ themeColors: pair, accentColor: '#abcdef' }, null, 'red')).toBe('linear-gradient(135deg, #112233, #445566)');
    expect(headerBackground({ themeColors: null, accentColor: '#abcdef' }, null, 'red')).toMatch(/^linear-gradient\(135deg, #abcdef,/); expect(headerBackground({}, null, 'red')).toBe('red');
    expect(bodyBackground({ themeColors: pair })).toContain('#112233'); expect(bodyBackground({ accentColor: '#abcdef' })).toContain('#abcdef'); expect(bodyBackground({})).toBeUndefined();
  });
});
