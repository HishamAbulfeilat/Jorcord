import { describe, expect, it } from 'vitest';
import type { Member } from '@jorcord/shared';
import { memberRows, type MemberListRow } from './MemberList';

const member = (id: string): Member => ({
  guildId: 'g1', user: { id, username: id, displayName: id, avatar: null } as Member['user'],
  nick: null, roles: [], joinedAt: '', timeoutUntil: null,
});

const idOf = (row: MemberListRow) => (row.kind === 'member' ? row.member.user.id : row.group.id);

describe('memberRows', () => {
  it('flattens each group into a header followed by its members, preserving order', () => {
    const rows = memberRows([
      { id: 'online', name: 'Online', members: [member('a'), member('b')] },
      { id: 'offline', name: 'Offline', members: [member('c')] },
    ]);
    expect(rows.map((r) => `${r.kind}:${idOf(r)}`)).toEqual(['group:online', 'member:a', 'member:b', 'group:offline', 'member:c']);
  });

  it('keeps member objects by reference so memoized rows survive a regroup', () => {
    const a = member('a');
    const rows = memberRows([{ id: 'online', name: 'Online', members: [a] }]);
    expect(rows[1]).toMatchObject({ kind: 'member', member: a, groupId: 'online' });
    expect(rows[0]).toMatchObject({ key: 'group:online', kind: 'group' });
    expect(rows[1]!.key).toBe('member:a');
  });

  it('produces unique keys across groups', () => {
    const rows = memberRows([
      { id: 'r1', name: 'Mods', members: [member('a')] },
      { id: 'r2', name: 'Friends', members: [member('b')] },
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
