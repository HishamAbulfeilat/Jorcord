import { describe, expect, it } from 'vitest';
import { BitrateGovernor, DEFAULT_GOVERNOR, bitrateLadder, parseScreenSignals } from '../src/adaptation';

const steps = [800, 1800, 3000, 5000, 8000];
const bad = (ts: number) => ({ ts, limitation: 'bandwidth', lossPct: 1, availableKbps: 2000 });
const good = (ts: number) => ({ ts, limitation: 'none', lossPct: 0, availableKbps: 20_000 });

describe('BitrateGovernor hysteresis', () => {
  it('ignores a single bad sample', () => {
    const g = new BitrateGovernor(steps);
    expect(g.push(bad(0)).changed).toBe(false);
    expect(g.push(good(2000)).changed).toBe(false);
    expect(g.kbps).toBe(8000);
  });
  it('steps down after sustained trouble, one step at a time', () => {
    const g = new BitrateGovernor(steps);
    g.push(bad(0));
    const d = g.push(bad(2000));
    expect(d).toMatchObject({ changed: true, kbps: 5000, reason: 'congestion' });
    // needs a fresh run of bad samples (and dwell) for the next step
    expect(g.push(bad(4000)).changed).toBe(false);
    expect(g.push(bad(6000)).kbps).toBe(3000);
  });
  it('steps up only after a long healthy run with headroom', () => {
    const g = new BitrateGovernor(steps, DEFAULT_GOVERNOR, 1);
    let ts = 0, ups = 0;
    for (let i = 0; i < 7; i++) { ts += 2000; if (g.push(good(ts)).changed) ups++; }
    expect(ups).toBe(0);
    ts += 2000;
    expect(g.push(good(ts))).toMatchObject({ changed: true, kbps: 3000, reason: 'recovered' });
  });
  it('requires headroom for the next step', () => {
    const g = new BitrateGovernor(steps, DEFAULT_GOVERNOR, 1);
    let ts = 0, changed = 0;
    for (let i = 0; i < 20; i++) { ts += 2000; if (g.push({ ts, limitation: 'none', lossPct: 0, availableKbps: 3100 }).changed) changed++; }
    expect(changed).toBe(0); // 3000 * 1.3 > 3100
  });
  it('does not flap: an oscillating link causes few moves and a growing delay before going up again', () => {
    const g = new BitrateGovernor(steps);
    let ts = 0, moves = 0;
    // 10 minutes of 20 s good / 6 s bad cycles
    for (let cycle = 0; cycle < 23; cycle++) {
      for (let i = 0; i < 10; i++) { ts += 2000; if (g.push(good(ts)).changed) moves++; }
      for (let i = 0; i < 3; i++) { ts += 2000; if (g.push(bad(ts)).changed) moves++; }
    }
    // a naive controller would move on nearly every cycle edge (>40 moves)
    expect(moves).toBeLessThan(24);
  });
  it('treats high loss and cpu limits as trouble, and never goes below the first step', () => {
    const g = new BitrateGovernor([500, 1000], DEFAULT_GOVERNOR, 1);
    g.push({ ts: 0, lossPct: 20 }); expect(g.push({ ts: 3000, limitation: 'cpu' }).kbps).toBe(500);
    for (let t = 6000; t < 60_000; t += 2000) g.push({ ts: t, lossPct: 30 });
    expect(g.index).toBe(0);
  });
  it('builds an ascending ladder ending at the top bitrate', () => {
    const l = bitrateLadder(12_000);
    expect(l[l.length - 1]).toBe(12_000); expect([...l].sort((a, b) => a - b)).toEqual(l); expect(l.length).toBeGreaterThanOrEqual(4);
    expect(bitrateLadder(300)).toEqual([300]);
  });
  it('extracts signals from a publisher stats report', () => {
    const rows = [
      { type: 'outbound-rtp', kind: 'video', frameWidth: 640, qualityLimitationReason: 'none' },
      { type: 'outbound-rtp', kind: 'video', frameWidth: 1920, qualityLimitationReason: 'bandwidth' },
      { type: 'candidate-pair', nominated: true, availableOutgoingBitrate: 4_000_000 },
      { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.05 },
    ];
    const s = parseScreenSignals({ forEach: (cb) => rows.forEach(cb) }, 5);
    expect(s).toMatchObject({ ts: 5, limitation: 'bandwidth', availableKbps: 4000 });
    expect(s.lossPct).toBeCloseTo(5);
  });
});
