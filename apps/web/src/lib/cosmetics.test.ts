import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const css = readFileSync(join(__dirname, '../cosmetics.css'), 'utf8');
import { AVATAR_DECORATIONS, NAME_PLATES, PROFILE_EFFECTS, SERVER_TAG_RE, TAG_BADGES } from '@jorcord/shared';
import { TAG_ICONS } from '@/components/ui/Cosmetics';

describe('cosmetics catalog', () => {
  it('every catalog id has CSS and ids are unique', () => {
    for (const [list, prefix] of [[AVATAR_DECORATIONS, 'deco'], [PROFILE_EFFECTS, 'fx'], [NAME_PLATES, 'plate']] as const) {
      expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
      for (const i of list) expect(css).toContain(`.${prefix}-${i.id}`);
    }
  });
  it('every tag badge has an icon; tags are 3-4 alphanumerics', () => {
    for (const b of TAG_BADGES) expect(TAG_ICONS[b.id as keyof typeof TAG_ICONS]).toBeTruthy();
    expect(SERVER_TAG_RE.test('ABCD')).toBe(true); expect(SERVER_TAG_RE.test('AB')).toBe(false); expect(SERVER_TAG_RE.test('AB CD')).toBe(false); expect(SERVER_TAG_RE.test('ABCDE')).toBe(false);
  });
});
