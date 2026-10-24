import { describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { diffLines } from './auditDiff';

describe('diffLines', () => {
  it('turns permission bitfields into added / removed names', () => {
    const l = diffLines({ diff: { before: { permissions: Perm.SEND_MESSAGES.toString() }, after: { permissions: (Perm.SEND_MESSAGES | Perm.MANAGE_MESSAGES).toString() } } });
    expect(l).toEqual([{ field: 'Permissions', before: null, after: null, added: ['Manage messages'], removed: [] }]);
  });
  it('resolves role ids, formats colours and plain values', () => {
    const l = diffLines({ diff: { before: { roles: ['a'], color: 0, nick: null }, after: { roles: ['b'], color: 0xff0000, nick: 'Bobby' } } }, (id) => ({ a: 'Mods', b: 'Helpers' }[id] ?? id));
    expect(l.find((x) => x.field === 'Roles')).toMatchObject({ added: ['Helpers'], removed: ['Mods'] });
    expect(l.find((x) => x.field === 'Color')).toMatchObject({ before: 'none', after: '#ff0000' });
    expect(l.find((x) => x.field === 'Nick')).toMatchObject({ before: null, after: 'Bobby' });
  });
  it('is empty without a diff and names camelCase fields', () => {
    expect(diffLines({ diff: null })).toEqual([]);
    expect(diffLines({ diff: { before: {}, after: { colorSecondary: true } } })[0]).toMatchObject({ field: 'Color secondary', after: 'on' });
  });
});
