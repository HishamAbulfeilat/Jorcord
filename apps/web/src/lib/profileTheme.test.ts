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
