import { describe, expect, it } from 'vitest';
import { activityElapsed, activityLabel, primaryActivity } from './activity';
import type { Activity } from '@jorcord/shared';

const a = (type: Activity['type'], name: string): Activity => ({ type, name, startedAt: '2026-01-01T00:00:00Z' });
describe('activities', () => {
  it('labels by type', () => { expect(activityLabel(a('playing', 'Chess'))).toBe('Playing Chess'); expect(activityLabel(a('listening', 'Lo-fi'))).toBe('Listening to Lo-fi'); expect(activityLabel(a('competing', 'Cup'))).toBe('Competing in Cup'); });
  it('prefers streaming as the primary activity', () => { expect(primaryActivity([a('playing', 'x'), a('streaming', 'y')])!.name).toBe('y'); expect(primaryActivity([])).toBeUndefined(); expect(primaryActivity(undefined)).toBeUndefined(); });
  it('formats elapsed time', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    expect(activityElapsed('2026-01-01T00:00:00Z', t0 + 5_000)).toBe('just now');
    expect(activityElapsed('2026-01-01T00:00:00Z', t0 + 61_000)).toBe('1 minute');
    expect(activityElapsed('2026-01-01T00:00:00Z', t0 + 3 * 3600_000)).toBe('3 hours');
    expect(activityElapsed('2026-01-01T00:00:00Z', t0 + 2 * 86400_000)).toBe('2 days');
  });
});
