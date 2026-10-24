import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@jorcord/shared';
import { LOW_CAPS, NORMAL_CAPS, _resetMemoryMode, getCaps, lruVictims, pruneTyping, setLowMemory, touchLru, trimWindow, userVictims } from './memory';
import { useMessages } from '@/stores/messages';
import { useData } from '@/stores/data';
import { runMemoryPass } from './memoryManager';
import { acquireSlot, animationSlotsInUse, releaseSlot } from '@/components/ui/AnimatedImage';

const user = (id: string) => ({ id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const msg = (n: number, ch = 'c1', author = 'u1'): Message => ({ id: String(1000 + n), channelId: ch, guildId: null, author: user(author), content: 'm' + n, createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, webhookId: null, flags: 0 } as unknown as Message);
/** Messages `from..to` newest first, like the API returns them. */
const run = (from: number, to: number, ch = 'c1') => Array.from({ length: to - from + 1 }, (_, i) => msg(to - i, ch));
const SLACK = 38; // ceil(150 * 0.25) in low-memory mode

beforeEach(() => { _resetMemoryMode(); localStorage.clear(); useMessages.setState({ ch: {}, pending: [], lru: [], viewers: {} }); useData.getState().reset(); });

describe('pure eviction helpers', () => {
  it('trimWindow keeps the cap with slack and drops the requested end', () => {
    const l = Array.from({ length: 100 }, (_, i) => i);
    expect(trimWindow(l, 90, 'start', 20).dropped).toBe(0); // within slack: untouched
    const a = trimWindow(l, 50, 'start', 10); expect(a.list).toHaveLength(50); expect(a.list[0]).toBe(50);
    const b = trimWindow(l, 50, 'end', 10); expect(b.list).toHaveLength(50); expect(b.list.at(-1)).toBe(49);
  });
  it('lruVictims evicts oldest-used first and skips protected ids', () => {
    expect(lruVictims(['a', 'b', 'c', 'd'], 2, () => false)).toEqual(['a', 'b']);
    expect(lruVictims(['a', 'b', 'c', 'd'], 2, (id) => id === 'a')).toEqual(['b', 'c']);
    expect(lruVictims(['a', 'b'], 5, () => false)).toEqual([]);
  });
  it('touchLru moves to the recent end', () => expect(touchLru(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']));
  it('userVictims never returns referenced ids', () => {
    expect(userVictims(['1', '2', '3', '4'], new Set(['1', '2']), 2)).toEqual(['3', '4']);
    expect(userVictims(['1', '2', '3', '4'], new Set(['1', '2', '3', '4']), 1)).toEqual([]);
    expect(userVictims(['1', '2'], new Set(), 5)).toEqual([]);
  });
  it('pruneTyping drops expired entries and keeps identity when nothing changed', () => {
    const fresh = { c: { u: 1000 } };
    expect(pruneTyping(fresh, 2000)).toBe(fresh);
    expect(pruneTyping({ c: { u: 1000 } }, 100_000)).toEqual({});
  });
  it('low-memory mode swaps the caps and persists', () => {
    expect(getCaps()).toBe(NORMAL_CAPS);
    setLowMemory(true); expect(getCaps()).toBe(LOW_CAPS); expect(localStorage.getItem('jorcord.lowMemory')).toBe('1');
    _resetMemoryMode(); expect(getCaps()).toBe(LOW_CAPS);
  });
});

describe('message store memory caps', () => {
  it('evicts least-recently-used channels beyond the cap but never a viewed one', () => {
    setLowMemory(true); // 4 channels
    useMessages.getState().view('c0'); // c0 stays open
    for (let i = 0; i < 8; i++) useMessages.getState().init('c' + i, run(1, 3, 'c' + i), 50);
    const ids = Object.keys(useMessages.getState().ch);
    expect(ids.length).toBeLessThanOrEqual(4);
    expect(ids).toContain('c0'); expect(ids).toContain('c7');
    expect(ids).not.toContain('c1');
  });
  it('does not evict a channel with an unsent message', () => {
    setLowMemory(true);
    useMessages.getState().addPending({ nonce: 'n', channelId: 'c1', content: 'x', files: [], replyTo: null, status: 'sending', createdAt: 0 });
    for (let i = 0; i < 8; i++) useMessages.getState().init('c' + i, run(1, 2, 'c' + i), 50);
    expect(useMessages.getState().ch.c1).toBeDefined();
  });
  it('gateway events for a channel nobody opened allocate nothing', () => {
    for (let i = 0; i < 500; i++) useMessages.getState().upsert(msg(i, 'never-opened'));
    useMessages.getState().update(msg(1, 'never-opened')); useMessages.getState().remove('never-opened', '1');
    expect(useMessages.getState().ch['never-opened']).toBeUndefined();
  });
  it('a flood of live messages stays bounded, keeps the newest, and flags older history as available', () => {
    setLowMemory(true);
    useMessages.getState().init('c1', run(1, 50), 50);
    for (let i = 51; i <= 2000; i++) useMessages.getState().upsert(msg(i));
    const c = useMessages.getState().ch.c1!;
    expect(c.list.length).toBeLessThanOrEqual(LOW_CAPS.messagesPerChannel + SLACK);
    expect(c.list.at(-1)!.id).toBe('3000');
    expect(c.hasMoreOlder).toBe(true);
  });
  it('paging back through history drops the newest end, paging forward drops the oldest', () => {
    setLowMemory(true);
    useMessages.getState().init('c1', run(500, 549), 50);
    for (let hi = 499; hi > 100; hi -= 50) useMessages.getState().prepend('c1', run(hi - 49, hi), 50);
    let c = useMessages.getState().ch.c1!;
    expect(c.list.length).toBeLessThanOrEqual(LOW_CAPS.messagesPerChannel + SLACK);
    expect(Number(c.list[0]!.id)).toBeLessThan(1150); // the oldest page just loaded is kept
    expect(c.hasMoreNewer).toBe(true);
    const oldest = c.list[0]!.id;
    for (let k = 1; k <= 6; k++) useMessages.getState().append('c1', run(2000 + k * 50, 2049 + k * 50), 50);
    c = useMessages.getState().ch.c1!;
    expect(c.list.length).toBeLessThanOrEqual(LOW_CAPS.messagesPerChannel + SLACK);
    expect(Number(c.list[0]!.id)).toBeGreaterThan(Number(oldest));
    expect(c.hasMoreOlder).toBe(true);
  });
});

describe('user/presence pruning', () => {
  it('drops unreferenced users beyond the cap, keeps members, me and message authors', () => {
    setLowMemory(true); // 1000 users
    const users: Record<string, ReturnType<typeof user>> = {}; const presences: Record<string, 'online'> = {};
    for (let i = 0; i < 1500; i++) { users['x' + i] = user('x' + i); presences['x' + i] = 'online'; }
    users.member = user('member'); users.author = user('author'); users.me = user('me');
    useData.setState({ users, presences, me: user('me') as never, guilds: { g: { members: { member: { user: user('member') } }, channels: {}, roles: {} } } as never });
    useMessages.setState({ ch: { c1: { list: [msg(1, 'c1', 'author')], loading: false, loadedInitial: true, hasMoreOlder: false, hasMoreNewer: false } } });
    const r = runMemoryPass();
    const d = useData.getState();
    expect(Object.keys(d.users).length).toBe(1000);
    expect(d.users.member && d.users.author && d.users.me).toBeTruthy();
    expect(r.usersDropped).toBe(503);
    expect(Object.keys(d.presences).length).toBeLessThan(1500);
  });
});

describe('animated image slots', () => {
  it('limits concurrently animating images to the cap and frees slots on release', () => {
    const tokens = Array.from({ length: 5 }, () => ({}));
    expect(tokens.map((t) => acquireSlot(t, 3))).toEqual([true, true, true, false, false]);
    releaseSlot(tokens[0]!); expect(acquireSlot(tokens[3]!, 3)).toBe(true);
    tokens.forEach(releaseSlot); expect(animationSlotsInUse()).toBe(0);
  });
});
