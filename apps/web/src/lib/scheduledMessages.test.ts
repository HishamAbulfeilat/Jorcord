import { describe, expect, it } from 'vitest';
import { fromLocalInput, presets, scheduleProblem, schedulePatch, toLocalInput } from './scheduledMessages';

describe('scheduled message time helpers', () => {
  it('round-trips datetime-local values in local time', () => {
    const d = new Date(2030, 0, 5, 7, 3); expect(toLocalInput(d)).toBe('2030-01-05T07:03'); expect(fromLocalInput('2030-01-05T07:03')?.getTime()).toBe(d.getTime());
    expect(fromLocalInput('')).toBeNull(); expect(fromLocalInput('nonsense')).toBeNull();
  });
  it('rejects times outside the 10 s - 30 day window', () => {
    const now = Date.UTC(2030, 0, 1);
    expect(scheduleProblem(null, now)).toBeTruthy();
    expect(scheduleProblem(new Date(now + 5_000), now)).toMatch(/future/);
    expect(scheduleProblem(new Date(now + 60_000), now)).toBeNull();
    expect(scheduleProblem(new Date(now + 31 * 86_400_000), now)).toMatch(/30 days/);
  });
  it('offers presets that are all in the future and in order', () => {
    for (const now of [new Date(2030, 0, 1, 8, 0), new Date(2030, 0, 1, 19, 30), new Date(2030, 0, 6, 12, 0) /* Sunday */, new Date(2030, 0, 7, 10, 0) /* Monday */]) {
      const p = presets(now); expect(p.length).toBeGreaterThanOrEqual(2);
      for (const x of p) expect(x.at.getTime()).toBeGreaterThan(now.getTime());
      expect(p.some((x) => x.id === 'evening')).toBe(now.getHours() < 18);
    }
    expect(presets(new Date(2030, 0, 3, 12, 0)).map((x) => x.id)).toContain('monday'); // Thursday: Monday is not tomorrow
  });
});

describe('schedulePatch', () => {
  const orig = { content: 'a', sendAt: '2030-01-01T00:00:00.000Z', attachments: [{ id: '1' }, { id: '2' }] };
  it('sends only what changed', () => {
    expect(schedulePatch(orig, { content: 'a', sendAt: '2030-01-01T00:00:00Z', attachmentIds: ['1', '2'] })).toEqual({});
    expect(schedulePatch(orig, { content: 'b', sendAt: '2030-01-02T00:00:00.000Z', attachmentIds: ['1'] })).toEqual({ content: 'b', sendAt: '2030-01-02T00:00:00.000Z', attachments: ['1'] });
    expect(schedulePatch(orig, { content: 'a', sendAt: orig.sendAt, attachmentIds: ['1', '2', '3'] })).toEqual({ attachments: ['1', '2', '3'] });
  });
});
