import { describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE, Perm } from '@jorcord/shared';
import type { Member, Role } from '@jorcord/shared';
import { PERMISSION_META, canPinMessage, roleNameStyle, roleTextStyle, canDeleteMessage, canManageMember, canManageRole, composerState, effectivePerms, groupMembers, overwriteState, roleColor, setOverwriteState, togglePerm, hasPermBit } from './perms';

const role = (id: string, position: number, perms: bigint, extra: Partial<Role> = {}): Role => ({ id, guildId: 'g', name: id, color: 0, hoist: false, position, permissions: perms.toString(), mentionable: false, icon: null, ...extra });
const user = (id: string) => ({ id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const mem = (id: string, roles: string[] = []): Member => ({ guildId: 'g', user: user(id), nick: null, roles, joinedAt: '', timeoutUntil: null });
const roles = [role('g', 0, DEFAULT_EVERYONE, { name: '@everyone' }), role('mod', 5, Perm.KICK_MEMBERS | Perm.MANAGE_MESSAGES, { color: 0xff0000, hoist: true }), role('admin', 10, Perm.ADMINISTRATOR)];
const guild = { id: 'g', ownerId: 'owner' };

describe('effectivePerms', () => {
  it('everyone defaults', () => {
    const p = effectivePerms({ guild, roles, member: mem('u') });
    expect(p & Perm.SEND_MESSAGES).toBeTruthy(); expect(p & Perm.KICK_MEMBERS).toBe(0n);
  });
  it('channel overwrites deny', () => {
    const p = effectivePerms({ guild, roles, member: mem('u') }, { parentId: null, overwrites: [{ id: 'g', type: 'role', allow: '0', deny: Perm.SEND_MESSAGES.toString() }] });
    expect(composerState(p, { type: 'text' }).canSend).toBe(false);
    expect(composerState(p, { type: 'text' }).reason).toMatch(/permission/);
  });
  it('admin and owner have all; timeouts restrict', () => {
    expect(effectivePerms({ guild, roles, member: mem('u', ['admin']) }) & Perm.BAN_MEMBERS).toBeTruthy();
    expect(effectivePerms({ guild, roles, member: mem('owner') }) & Perm.MANAGE_GUILD).toBeTruthy();
    const t = { ...mem('u'), timeoutUntil: new Date(Date.now() + 60000).toISOString() };
    expect(composerState(effectivePerms({ guild, roles, member: t }), { type: 'text' }).canSend).toBe(false);
  });
  it('archived threads block sending', () => {
    const p = effectivePerms({ guild, roles, member: mem('u') });
    expect(composerState(p, { type: 'thread', archived: true }).canSend).toBe(false);
    expect(composerState(p, { type: 'thread' }).canSend).toBe(true);
  });
});

describe('hierarchy', () => {
  const modM = mem('m', ['mod']), plain = mem('p'), adminM = mem('a', ['admin']);
  const mp = effectivePerms({ guild, roles, member: modM });
  it('mods can kick lower members only', () => {
    expect(canManageMember(guild, roles, modM, plain, mp, Perm.KICK_MEMBERS)).toBe(true);
    expect(canManageMember(guild, roles, modM, adminM, mp, Perm.KICK_MEMBERS)).toBe(false);
    expect(canManageMember(guild, roles, modM, mem('owner'), mp, Perm.KICK_MEMBERS)).toBe(false);
    expect(canManageMember(guild, roles, modM, modM, mp, Perm.KICK_MEMBERS)).toBe(false);
  });
  it('role management needs MANAGE_ROLES and higher position', () => {
    const ap = effectivePerms({ guild, roles, member: adminM });
    expect(canManageRole(guild, roles, adminM, roles[1], ap)).toBe(true);
    expect(canManageRole(guild, roles, modM, roles[2], mp)).toBe(false);
  });
  it('message delete', () => {
    expect(canDeleteMessage({ author: { id: 'u' } }, 'u', 0n)).toBe(true);
    expect(canDeleteMessage({ author: { id: 'x' } }, 'u', 0n)).toBe(false);
    expect(canDeleteMessage({ author: { id: 'x' } }, 'u', Perm.MANAGE_MESSAGES)).toBe(true);
  });
});

describe('member list + role helpers', () => {
  it('groups hoisted, online, offline', () => {
    const ms = [mem('b', ['mod']), mem('a'), mem('c')];
    const pres = (id: string) => (id === 'c' ? 'offline' : 'online');
    const g = groupMembers(ms, roles, pres, 'g');
    expect(g.map((x) => x.name)).toEqual(['mod', 'Online', 'Offline']);
  });
  it('role color picks highest colored role', () => {
    expect(roleColor(mem('b', ['mod']), roles)).toBe('#ff0000');
    expect(roleColor(mem('x'), roles)).toBeUndefined();
  });
  it('overwrite tri-state', () => {
    const base = { allow: '0', deny: '0' };
    const allowed = setOverwriteState(base, 'SEND_MESSAGES', 'allow');
    expect(overwriteState(allowed, 'SEND_MESSAGES')).toBe('allow');
    const denied = setOverwriteState(allowed, 'SEND_MESSAGES', 'deny');
    expect(overwriteState(denied, 'SEND_MESSAGES')).toBe('deny');
    expect(overwriteState(setOverwriteState(denied, 'SEND_MESSAGES', 'inherit'), 'SEND_MESSAGES')).toBe('inherit');
  });
  it('togglePerm', () => {
    const b = togglePerm('0', 'ATTACH_FILES', true); expect(hasPermBit(b, 'ATTACH_FILES')).toBe(true);
    expect(hasPermBit(togglePerm(b, 'ATTACH_FILES', false), 'ATTACH_FILES')).toBe(false);
  });
});

describe('composerState: screening and locked threads', () => {
  const p = effectivePerms({ guild, roles, member: mem('u') });
  it('pending members cannot send until they accept the rules', () => {
    expect(composerState(p, { type: 'text' }, { pending: true })).toMatchObject({ canSend: false, canAttach: false, reason: 'Accept the server rules to start chatting.' });
    expect(composerState(p, { type: 'text' }, { pending: false }).canSend).toBe(true);
  });
  it('a locked thread blocks posting without MANAGE_THREADS, open or archived', () => {
    expect(composerState(p, { type: 'thread', locked: true })).toMatchObject({ canSend: false, reason: 'This thread is locked.' });
    expect(composerState(p | Perm.MANAGE_THREADS, { type: 'thread', locked: true }).canSend).toBe(true);
    expect(composerState(p, { type: 'thread', locked: true, archived: true })).toMatchObject({ canSend: false, reason: 'This thread is archived and locked.' });
    expect(composerState(p, { type: 'thread', archived: true })).toMatchObject({ canSend: false, reason: 'This thread is archived.' });
  });
});

describe('gradient role colours', () => {
  const plain = role('plain', 3, 0n, { color: 0xff0000 });
  const grad = role('grad', 4, 0n, { color: 0x00ff00, colorSecondary: 0x0000ff });
  it('a single colour renders as a plain colour, a secondary colour as a clipped left-to-right gradient', () => {
    expect(roleTextStyle(plain)).toEqual({ color: '#ff0000' });
    expect(roleTextStyle(role('none', 1, 0n))).toBeUndefined();
    const s = roleTextStyle(grad)!;
    expect(s.backgroundImage).toBe('linear-gradient(90deg, #00ff00, #0000ff)');
    expect(s).toMatchObject({ backgroundClip: 'text', WebkitTextFillColor: 'transparent' });
  });
  it('the highest coloured role decides, and a secondary colour without a primary one is ignored', () => {
    const rs = [plain, grad, role('ghost', 9, 0n, { color: 0, colorSecondary: 0x123456 })];
    expect(roleNameStyle(mem('u', ['plain', 'grad', 'ghost']), rs)?.backgroundImage).toContain('#00ff00');
    expect(roleNameStyle(mem('u', ['plain']), rs)).toEqual({ color: '#ff0000' });
    expect(roleNameStyle(mem('u', ['ghost']), rs)).toBeUndefined();
    expect(roleNameStyle(undefined, rs)).toBeUndefined();
  });
});

describe('new permission bits in the UI', () => {
  it('pin needs PIN_MESSAGES (not MANAGE_MESSAGES) in servers and is open in DMs', () => {
    expect(canPinMessage(Perm.MANAGE_MESSAGES, false)).toBe(false);
    expect(canPinMessage(Perm.PIN_MESSAGES, false)).toBe(true);
    expect(canPinMessage(Perm.ADMINISTRATOR, false)).toBe(true);
    expect(canPinMessage(0n, true)).toBe(true);
  });
  it('every permission has a label in the role editor, including PIN_MESSAGES, BYPASS_SLOWMODE and USE_EXTERNAL_STICKERS', () => {
    const names = new Set(PERMISSION_META.map((p) => p.name));
    for (const n of Object.keys(Perm)) expect(names.has(n as keyof typeof Perm), n).toBe(true);
    expect(PERMISSION_META.find((p) => p.name === 'PIN_MESSAGES')).toMatchObject({ label: 'Pin Messages', group: 'Text' });
  });
});
