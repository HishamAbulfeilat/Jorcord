import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallRing } from '@jorcord/shared';
import { useCalls, activeRing } from './calls';
import { startRingLoop } from '@/lib/ringtone';

const ring = (o: Partial<CallRing> = {}): CallRing => ({ callId: 'c1', channelId: 'dm1', userId: 'u1', name: 'Ann', channelType: 'dm', groupName: null, startedAt: new Date(1000).toISOString(), expiresAt: new Date(31_000).toISOString(), silent: false, ...o });
beforeEach(() => useCalls.setState({ rings: {} }));

describe('incoming call store', () => {
  it('rings, ignores locally, and ends only the matching call', () => {
    useCalls.getState().ring(ring());
    expect(activeRing(useCalls.getState().rings)?.callId).toBe('c1');
    useCalls.getState().ignore('dm1');
    expect(activeRing(useCalls.getState().rings)).toBeNull(); // ignored: no modal, no sound, but still known
    useCalls.getState().ring(ring()); // a repeat of the same ring keeps it ignored
    expect(activeRing(useCalls.getState().rings)).toBeNull();
    useCalls.getState().end('dm1', 'other-call'); expect(useCalls.getState().rings.dm1).toBeDefined();
    useCalls.getState().end('dm1', 'c1'); expect(useCalls.getState().rings).toEqual({});
  });
  it('a new call in the same channel rings again even if the last one was ignored', () => {
    useCalls.getState().ring(ring()); useCalls.getState().ignore('dm1');
    useCalls.getState().ring(ring({ callId: 'c2' }));
    expect(activeRing(useCalls.getState().rings)?.callId).toBe('c2');
  });
  it('expires rings after expiresAt and drops expired ones from READY', () => {
    useCalls.getState().ring(ring());
    useCalls.getState().expire(30_999); expect(useCalls.getState().rings.dm1).toBeDefined();
    useCalls.getState().expire(31_001); expect(useCalls.getState().rings).toEqual({});
    useCalls.getState().setAll([ring(), ring({ channelId: 'dm2', callId: 'c9', expiresAt: new Date(500).toISOString() })], 2_000);
    expect(Object.keys(useCalls.getState().rings)).toEqual(['dm1']);
  });
  it('the newest un-ignored ring is the one shown', () => {
    useCalls.getState().ring(ring()); useCalls.getState().ring(ring({ channelId: 'dm2', callId: 'c2', startedAt: new Date(5000).toISOString() }));
    expect(activeRing(useCalls.getState().rings)?.channelId).toBe('dm2');
  });
});

describe('ring loop', () => {
  it('plays immediately, repeats, and stops for good', () => {
    vi.useFakeTimers(); const play = vi.fn();
    const loop = startRingLoop(play, 2000, globalThis);
    expect(play).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000); expect(play).toHaveBeenCalledTimes(3);
    loop.stop(); loop.stop(); vi.advanceTimersByTime(10_000); expect(play).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
