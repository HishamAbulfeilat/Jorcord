import { describe, expect, it } from 'vitest';
import { BOOST_LEVELS } from '@jorcord/shared';
import { boostAnnouncement, levelGain, levelProgress, perkRows } from './boosts';

describe('boost presentation', () => {
  it('lists emoji/sticker slots as level-gated and the rest as unlocked for everyone', () => {
    const rows = perkRows(BOOST_LEVELS[2]!);
    expect(rows.find((r) => r.id === 'emoji')).toEqual({ id: 'emoji', label: 'Emoji slots', value: '150', gated: true });
    expect(rows.filter((r) => r.gated).map((r) => r.id)).toEqual(['emoji', 'sticker']);
    expect(rows.find((r) => r.id === 'upload')!.value).toBe('500 MB');
    expect(levelGain(1)).toEqual(['+50 emoji slots (100 total)', '+10 sticker slots (15 total)']);
  });
  it('progress counts from the current level to the next', () => {
    const lvl = (count: number, level: 0 | 1 | 2 | 3) => levelProgress({ count, level, nextLevel: level < 3 ? BOOST_LEVELS[level + 1]! : null });
    expect([lvl(0, 0), lvl(1, 0), lvl(2, 1), lvl(4, 1), lvl(7, 2), lvl(20, 3)]).toEqual([0, 50, 0, 40, 0, 100]);
  });
  it('announcements: plain, several at once, level reached; junk falls back', () => {
    expect(boostAnnouncement('')).toBe('just boosted the server!');
    expect(boostAnnouncement('x3')).toBe('just boosted the server 3 times!');
    expect(boostAnnouncement('level:2', 'Lab')).toBe('just boosted Lab! It reached Level 2!');
    expect(boostAnnouncement('level:9')).toBe('just boosted the server!');
  });
});
