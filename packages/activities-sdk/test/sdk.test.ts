import { describe, expect, it } from 'vitest';
import { ACTIVITY_PROTOCOL, type ChannelActivity } from '@jorcord/shared';
import { createActivityHost, activityFrameUrl } from '../../../apps/web/src/lib/activityHost';
import { JorcordActivity, PROTOCOL, ActivityError, type Transport } from '../src/index';

const HOST = 'https://jorcord.example.com', APP = 'https://game.example.com';
const frame = { id: 'frame' }, parent = { id: 'parent' }, rogue = { id: 'rogue' };

const activity = (state: unknown = {}): ChannelActivity => ({ id: '1', channelId: '2', guildId: '3', kind: 'app', hostId: '4', applicationId: '5', state, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

/** Wires an SDK instance to a host through two in-memory "windows", like the browser would between iframe and parent. */
function wire(opts: { setState?: (s: unknown) => Promise<ChannelActivity>; hostOrigin?: string } = {}) {
  let current = activity({ n: 0 });
  let sdkListener: ((e: { data: unknown; origin: string; source: unknown }) => void) | null = null;
  const toFrame: unknown[] = [];
  const closed: number[] = [];
  const host = createActivityHost({
    activityOrigin: APP, frameWindow: () => frame,
    post: (m, origin) => { expect(origin).toBe(APP); toFrame.push(m); queueMicrotask(() => sdkListener?.({ data: m, origin: HOST, source: parent })); },
    getActivity: () => current,
    getParticipants: () => [{ id: '4', username: 'amy', displayName: 'Amy', avatar: null, selfMute: false, selfDeaf: false }],
    getViewer: () => ({ id: '4', username: 'amy', displayName: 'Amy', avatar: null }),
    setState: opts.setState ?? (async (s) => { current = { ...current, state: s }; return current; }),
    close: () => closed.push(1),
  });
  const transport: Transport = {
    hostWindow: parent,
    target: { postMessage: (m, origin) => { expect(origin).toBe(opts.hostOrigin ?? HOST); void host.onMessage({ data: m, origin: APP, source: frame }); } },
    listen: (h) => { sdkListener = h; return () => { sdkListener = null; }; },
  };
  const sdk = new JorcordActivity({ hostOrigin: opts.hostOrigin ?? HOST, transport, timeoutMs: 200 });
  return { sdk, host, toFrame, closed, deliver: (data: unknown, origin = HOST, source: unknown = parent) => sdkListener?.({ data, origin, source }) };
}

describe('activities SDK <-> host', () => {
  it('keeps the protocol constants in sync', () => {
    expect(PROTOCOL.source).toBe(ACTIVITY_PROTOCOL.source);
    expect(PROTOCOL.version).toBe(ACTIVITY_PROTOCOL.version);
    expect([...PROTOCOL.requests]).toEqual([...ACTIVITY_PROTOCOL.requests]);
    expect([...PROTOCOL.subscriptions]).toEqual([...ACTIVITY_PROTOCOL.subscriptions]);
  });

  it('ready, participants, user, state and close round-trip', async () => {
    const { sdk, closed } = wire();
    const r = await sdk.ready();
    expect(r.instance).toMatchObject({ id: '1', applicationId: '5', channelId: '2', guildId: '3', state: { n: 0 } });
    expect(r.user.username).toBe('amy');
    expect(r.participants).toHaveLength(1);
    expect((await sdk.getParticipants())[0]!.displayName).toBe('Amy');
    expect((await sdk.getUser()).id).toBe('4');
    expect((await sdk.setState({ n: 2 })).state).toEqual({ n: 2 });
    expect((await sdk.getInstance()).state).toEqual({ n: 2 });
    await sdk.close();
    expect(closed).toHaveLength(1);
  });

  it('rejects oversized state without calling the server and surfaces host errors', async () => {
    const calls: unknown[] = [];
    const { sdk } = wire({ setState: async (s) => { calls.push(s); throw new Error('boom'); } });
    await expect(sdk.setState({ blob: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'STATE_TOO_LARGE' });
    expect(calls).toHaveLength(0);
    await expect(sdk.setState({ ok: 1 })).rejects.toMatchObject({ code: 'SET_STATE_FAILED', message: 'boom' });
  });

  it('delivers events only to subscribed events and stops after unsubscribe', async () => {
    const { sdk, host } = wire();
    const seen: unknown[] = [];
    const off = sdk.subscribe('VOICE_STATE_UPDATE', (p) => seen.push(p));
    await new Promise((r) => setTimeout(r, 10)); // subscribe round-trip
    host.emit('VOICE_STATE_UPDATE', [{ id: '4' }]);
    host.emit('ACTIVITY_UPDATE', { not: 'subscribed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([[{ id: '4' }]]);
    off();
    await new Promise((r) => setTimeout(r, 10));
    host.emit('VOICE_STATE_UPDATE', []);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(() => sdk.subscribe('NOPE' as never, () => {})).toThrow(ActivityError);
  });

  it('the host ignores other windows, other origins and malformed envelopes', async () => {
    const posts: unknown[] = [];
    const host = createActivityHost({
      activityOrigin: APP, frameWindow: () => frame, post: (m) => posts.push(m), getActivity: () => activity(), getParticipants: () => [], getViewer: () => null, setState: async () => activity(), close: () => {},
    });
    const good = { source: 'jorcord-activity', v: 1, type: 'GET_PARTICIPANTS', id: 1 };
    await host.onMessage({ data: good, origin: APP, source: rogue }); // another window (e.g. a sibling frame)
    await host.onMessage({ data: good, origin: 'https://evil.example.com', source: frame }); // the frame navigated somewhere else
    await host.onMessage({ data: { ...good, source: 'other' }, origin: APP, source: frame });
    await host.onMessage({ data: { ...good, v: 2 }, origin: APP, source: frame });
    await host.onMessage({ data: 'string', origin: APP, source: frame });
    await host.onMessage({ data: good, origin: APP, source: null });
    expect(posts).toHaveLength(0);
    await host.onMessage({ data: good, origin: APP, source: frame });
    expect(posts).toHaveLength(1);
    await host.onMessage({ data: { ...good, id: 2, type: 'DROP_TABLES' }, origin: APP, source: frame });
    expect(posts[1]).toMatchObject({ ok: false, code: 'UNKNOWN_REQUEST' });
  });

  it('the SDK ignores messages that do not come from the host window and origin', async () => {
    const { sdk, deliver } = wire();
    const p = sdk.getUser();
    deliver({ source: 'jorcord-activity', v: 1, type: 'RESPONSE', id: 1, ok: true, payload: { id: 'attacker' } }, 'https://evil.example.com');
    deliver({ source: 'jorcord-activity', v: 1, type: 'RESPONSE', id: 1, ok: true, payload: { id: 'attacker' } }, HOST, rogue);
    expect((await p).id).toBe('4'); // the genuine answer still wins
  });

  it('requires a host origin and times out unanswered requests', async () => {
    expect(() => new JorcordActivity({ transport: { hostWindow: parent, target: { postMessage() {} }, listen: () => () => {} } })).toThrow(/host origin/);
    const silent = new JorcordActivity({ hostOrigin: HOST, timeoutMs: 20, transport: { hostWindow: parent, target: { postMessage() {} }, listen: () => () => {} } });
    await expect(silent.getUser()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('builds the frame URL only for https activity URLs', () => {
    const ctx = { hostOrigin: HOST, activity: { id: '1', channelId: '2', guildId: '3', applicationId: '5' } };
    const u = new URL(activityFrameUrl('https://game.example.com/play?x=1', ctx)!);
    expect(u.origin).toBe(APP);
    expect(u.searchParams.get('x')).toBe('1');
    expect(u.searchParams.get('jorcord_host')).toBe(HOST);
    expect(u.searchParams.get('instance_id')).toBe('1');
    expect(activityFrameUrl('http://game.example.com/', ctx)).toBeNull();
    expect(activityFrameUrl('javascript:alert(1)', ctx)).toBeNull();
    expect(activityFrameUrl(null, ctx)).toBeNull();
  });
});
