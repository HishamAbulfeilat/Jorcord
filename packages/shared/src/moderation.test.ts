import { describe, expect, it } from 'vitest';
import { Perm } from './permissions';
import {
  DEFAULT_MOD_SETTINGS, EVASION_MIN_SCORE, diffFields, evasionScore, evasionSignals, inQuietHours, normalizeModSettings, permissionDelta, reporterThrottled, restorableRoles,
  type CurrentRole,
} from './moderation';

describe('normalizeModSettings', () => {
  it('fills defaults and clamps untrusted input', () => {
    expect(normalizeModSettings(null)).toEqual(DEFAULT_MOD_SETTINGS);
    const s = normalizeModSettings({ rememberRoles: { days: 999, onLeave: 'yes' }, retention: { auditDays: 5, editDays: 9999 }, notices: { showModerator: true } });
    expect(s.rememberRoles.days).toBe(30); expect(s.rememberRoles.onLeave).toBe(false);
    expect(s.retention).toEqual({ auditDays: 30, editDays: 365 });
    expect(s.notices).toEqual({ enabled: true, showModerator: true, appealLink: true });
  });
  it('defaults: remember roles on for kicks, moderator hidden, evasion off, nothing deleted', () => {
    expect(DEFAULT_MOD_SETTINGS.rememberRoles).toMatchObject({ enabled: true, onKick: true, onLeave: false });
    expect(DEFAULT_MOD_SETTINGS.notices.showModerator).toBe(false);
    expect(DEFAULT_MOD_SETTINGS.evasion.enabled).toBe(false);
    expect(DEFAULT_MOD_SETTINGS.retention).toEqual({ auditDays: null, editDays: null });
  });
});

describe('diffFields', () => {
  it('keeps only what changed', () => {
    expect(diffFields({ a: 1, b: 'x', c: [1] }, { a: 2, b: 'x', c: [1] })).toEqual({ before: { a: 1 }, after: { a: 2 } });
    expect(diffFields({ a: 1 }, { a: 1 })).toBeNull();
    expect(diffFields({}, { name: 'new' })).toEqual({ before: {}, after: { name: 'new' } });
  });
  it('permission delta names added and removed bits', () => {
    expect(permissionDelta((Perm.SEND_MESSAGES | Perm.EMBED_LINKS).toString(), (Perm.SEND_MESSAGES | Perm.MANAGE_MESSAGES).toString())).toEqual({ added: ['MANAGE_MESSAGES'], removed: ['EMBED_LINKS'] });
  });
});

describe('restorableRoles', () => {
  const cur = (o: Partial<CurrentRole> & { id: string }): CurrentRole => ({ position: 1, permissions: '0', managed: false, ...o });
  const map = (...r: CurrentRole[]) => new Map(r.map((x) => [x.id, x]));
  const mod = (top: number, perms: bigint) => ({ isOwner: false, administrator: false, topPosition: top, perms });
  it('restores roles the moderator could grant, skips gone, managed and escalated ones', () => {
    const r = restorableRoles('g', [{ id: 'a', permissions: '0' }, { id: 'gone', permissions: '0' }, { id: 'man', permissions: '0' }, { id: 'grew', permissions: '1' }],
      map(cur({ id: 'a' }), cur({ id: 'man', managed: true }), cur({ id: 'grew', permissions: '3' })), mod(10, Perm.ADMINISTRATOR | 3n));
    expect(r.restore).toEqual(['a']);
    expect(r.skipped.map((s) => s.why)).toEqual(['gone', 'managed', 'escalated']);
  });
  it('re-checks the hierarchy and the permissions the moderator holds', () => {
    const roles = map(cur({ id: 'above', position: 9 }), cur({ id: 'beyond', position: 2, permissions: Perm.BAN_MEMBERS.toString() }), cur({ id: 'ok', position: 2, permissions: Perm.KICK_MEMBERS.toString() }));
    const rem = [{ id: 'above', permissions: '0' }, { id: 'beyond', permissions: Perm.BAN_MEMBERS.toString() }, { id: 'ok', permissions: Perm.KICK_MEMBERS.toString() }];
    const r = restorableRoles('g', rem, roles, mod(5, Perm.KICK_MEMBERS));
    expect(r.restore).toEqual(['ok']);
    expect(r.skipped).toEqual([{ id: 'above', why: 'above_moderator' }, { id: 'beyond', why: 'beyond_moderator' }]);
    expect(restorableRoles('g', rem, roles, { isOwner: true, administrator: false, topPosition: 0, perms: 0n }).restore).toHaveLength(3);
  });
  it('without a moderator, privileged roles are not handed back', () => {
    const roles = map(cur({ id: 'plain' }), cur({ id: 'mods', permissions: Perm.KICK_MEMBERS.toString() }));
    const r = restorableRoles('g', [{ id: 'plain', permissions: '0' }, { id: 'mods', permissions: Perm.KICK_MEMBERS.toString() }], roles, null);
    expect(r.restore).toEqual(['plain']); expect(r.skipped).toEqual([{ id: 'mods', why: 'privileged' }]);
  });
});

describe('evasion signals', () => {
  const banned = { username: 'darklord', displayName: 'Dark Lord Zed', avatar: '/a.png', bannedAt: '2026-01-01T00:00:00Z', joinedVia: 'abc' };
  it('an identical or look-alike name is enough; timing, avatar and invite only add up', () => {
    const same = evasionSignals({ username: 'x1', displayName: 'dark l0rd zed', createdAt: '2026-01-03T00:00:00Z' }, banned);
    expect(evasionScore(same)).toBeGreaterThanOrEqual(EVASION_MIN_SCORE);
    const weak = evasionSignals({ username: 'someone', createdAt: '2026-01-03T00:00:00Z', joinedVia: 'abc' }, banned);
    expect(weak.map((s) => s.kind).sort()).toEqual(['invite', 'timing']);
    expect(evasionScore(weak)).toBeLessThan(EVASION_MIN_SCORE);
    const avatarTiming = evasionSignals({ username: 'someone', avatar: '/a.png', createdAt: '2026-01-05T00:00:00Z' }, banned);
    expect(evasionScore(avatarTiming)).toBeGreaterThanOrEqual(EVASION_MIN_SCORE);
  });
  it('an old account is not "created after the ban", short names are ignored', () => {
    expect(evasionSignals({ username: 'abc', createdAt: '2020-01-01T00:00:00Z' }, { username: 'abc', bannedAt: '2026-01-01T00:00:00Z' })).toEqual([]);
  });
});

describe('reporterThrottled / inQuietHours', () => {
  it('throttles mostly-dismissed reporters only', () => {
    expect(reporterThrottled({ dismissed: 5, resolved: 0 })).toBe(true);
    expect(reporterThrottled({ dismissed: 5, resolved: 5 })).toBe(false);
    expect(reporterThrottled({ dismissed: 2, resolved: 0 })).toBe(false);
  });
  it('quiet hours wrap midnight and respect the time zone', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 5, 1, h, m);
    const q = { start: 22 * 60, end: 7 * 60, tzOffset: 0 };
    expect(inQuietHours(q, at(23))).toBe(true); expect(inQuietHours(q, at(3))).toBe(true); expect(inQuietHours(q, at(12))).toBe(false); expect(inQuietHours(q, at(7))).toBe(false);
    expect(inQuietHours({ ...q, tzOffset: 120 }, at(20, 30))).toBe(true); // 22:30 local
    expect(inQuietHours({ start: 600, end: 600, tzOffset: 0 }, at(10))).toBe(false);
    expect(inQuietHours(null)).toBe(false); expect(inQuietHours({ start: null, end: null, tzOffset: 0 })).toBe(false);
  });
});
