import { describe, expect, it, vi } from 'vitest';
import type { Presence } from '@jorcord/shared';
import { createIdleController } from './idle';

function setup(opts: { minutes?: number; presence?: Presence; sys?: number | null } = {}) {
  const st = { now: 0, presence: (opts.presence ?? 'online') as Presence | null, sys: opts.sys ?? null as number | null, minutes: opts.minutes ?? 5 };
  const setPresence = vi.fn((p: Presence) => { st.presence = p; });
  const c = createIdleController({ minutes: () => st.minutes, presence: () => st.presence, setPresence, systemIdle: async () => st.sys, now: () => st.now });
  return { st, c, setPresence };
}

describe('idle presence', () => {
  it('goes idle after the configured minutes and returns on activity', async () => {
    const { st, c, setPresence } = setup();
    st.now = 4 * 60_000; await c.tick(); expect(setPresence).not.toHaveBeenCalled();
    st.now = 5 * 60_000; await c.tick(); expect(setPresence).toHaveBeenLastCalledWith('idle'); expect(c.isAuto()).toBe(true);
    c.activity(); expect(setPresence).toHaveBeenLastCalledWith('online'); expect(c.isAuto()).toBe(false);
  });
  it('never touches DND or invisible', async () => {
    for (const p of ['dnd', 'invisible'] as const) {
      const { st, c, setPresence } = setup({ presence: p }); st.now = 60 * 60_000; await c.tick(); c.activity();
      expect(setPresence).not.toHaveBeenCalled();
    }
  });
  it('does not undo an idle the user chose by hand', async () => {
    const { st, c, setPresence } = setup({ presence: 'idle' });
    st.now = 60 * 60_000; await c.tick(); c.activity(); expect(setPresence).not.toHaveBeenCalled();
  });
  it('a manual status change cancels the automatic idle', async () => {
    const { st, c, setPresence } = setup();
    st.now = 6 * 60_000; await c.tick(); expect(c.isAuto()).toBe(true);
    st.presence = 'dnd'; await c.tick(); expect(c.isAuto()).toBe(false);
    c.activity(); expect(setPresence).toHaveBeenCalledTimes(1);
  });
  it('0 minutes disables it and restores an automatic idle', async () => {
    const { st, c, setPresence } = setup();
    st.now = 6 * 60_000; await c.tick(); st.minutes = 0; await c.tick();
    expect(setPresence).toHaveBeenLastCalledWith('online');
  });
  it('uses the OS idle time when available (input in another app counts)', async () => {
    const { st, c, setPresence } = setup({ sys: 400 }); // 400 s idle system-wide, but no in-window events at all
    st.now = 1000; await c.tick(); expect(setPresence).toHaveBeenLastCalledWith('idle');
    st.sys = 1; await c.tick(); expect(setPresence).toHaveBeenLastCalledWith('online');
  });
  it('a wake from sleep brings an automatic idle back online', async () => {
    const { st, c, setPresence } = setup(); st.now = 6 * 60_000; await c.tick(); st.now = 600 * 60_000; c.resumed();
    expect(setPresence).toHaveBeenLastCalledWith('online');
  });
});
