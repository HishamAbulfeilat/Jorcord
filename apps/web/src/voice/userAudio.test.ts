import { describe, it, expect } from 'vitest';
import { clampPercent, userPercent, withUserVolume, withUserMuted, audioMapsForClient, MAX_USER_AUDIO_ENTRIES } from './userAudio';

describe('per-user audio prefs', () => {
  it('clamps to 0-200 and defaults to 100', () => {
    expect(clampPercent(-5)).toBe(0); expect(clampPercent(999)).toBe(200); expect(clampPercent(NaN)).toBe(100); expect(clampPercent(49.6)).toBe(50);
    expect(userPercent({ userVolumes: {} }, 'u')).toBe(100); expect(userPercent({ userVolumes: { u: 150 } }, 'u')).toBe(150);
  });
  it('drops default entries so the synced settings blob stays small', () => {
    expect(withUserVolume({ userVolumes: { u: 150 } }, 'u', 100)).toEqual({});
    expect(withUserVolume({ userVolumes: {} }, 'u', 0)).toEqual({ u: 0 });
    expect(withUserMuted({ userMuted: { u: true } }, 'u', false)).toEqual({});
    expect(withUserMuted({ userMuted: {} }, 'u', true)).toEqual({ u: true });
  });
  it('caps the number of remembered people, keeping the newest', () => {
    let m: Record<string, number> = {};
    for (let i = 0; i < MAX_USER_AUDIO_ENTRIES + 20; i++) m = withUserVolume({ userVolumes: m }, `u${i}`, 50);
    expect(Object.keys(m)).toHaveLength(MAX_USER_AUDIO_ENTRIES); expect(m[`u${MAX_USER_AUDIO_ENTRIES + 19}`]).toBe(50); expect(m.u0).toBeUndefined();
  });
  it('converts to client units', () => {
    expect(audioMapsForClient({ userVolumes: { a: 200, b: 25 }, userMuted: { c: true } })).toEqual({ volumes: { a: 2, b: 0.25 }, muted: { c: true } });
  });
});
