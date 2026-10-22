import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioBoost } from '../src/boost';

function fakeCtx(state = 'running', sink = true) {
  const gains: any[] = []; const srcs: any[] = [];
  const ctx: any = {
    state, destination: {}, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createGain: vi.fn(() => { const g: any = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; gains.push(g); return g; }),
    createMediaStreamSource: vi.fn(() => { const s: any = { connect: vi.fn(), disconnect: vi.fn() }; srcs.push(s); return s; }),
  };
  if (sink) ctx.setSinkId = vi.fn(async () => {});
  return { ctx, gains, srcs };
}
beforeEach(() => { (globalThis as any).MediaStream = class { constructor(public t: any[]) {} }; });

describe('AudioBoost', () => {
  it('routes a track through a gain node and updates the gain in place', () => {
    const f = fakeCtx(); const b = new AudioBoost({ createContext: () => f.ctx });
    const t: any = {};
    expect(b.boost('a:mic', t, 1.5)).toBe(true); expect(f.gains[0].gain.value).toBe(1.5);
    expect(b.boost('a:mic', t, 2)).toBe(true); expect(f.gains).toHaveLength(1); expect(f.gains[0].gain.value).toBe(2);
    b.release('a:mic'); expect(f.srcs[0].disconnect).toHaveBeenCalled(); expect(b.has('a:mic')).toBe(false);
  });
  it('declines (caller caps at 100 %) when the context is suspended or unavailable', () => {
    const s = fakeCtx('suspended'); const b = new AudioBoost({ createContext: () => s.ctx });
    expect(b.boost('k', {} as any, 1.5)).toBe(false); expect(s.ctx.resume).toHaveBeenCalled();
    const n = new AudioBoost({ createContext: () => { throw new Error('no audio'); } });
    expect(n.boost('k', {} as any, 1.5)).toBe(false);
  });
  it('honours the chosen speaker via setSinkId, or declines when it cannot', () => {
    const f = fakeCtx('running', true); const b = new AudioBoost({ createContext: () => f.ctx, outputDeviceId: () => 'spk1' });
    expect(b.boost('k', {} as any, 1.5)).toBe(true); expect(f.ctx.setSinkId).toHaveBeenCalledWith('spk1');
    const g = fakeCtx('running', false); const c = new AudioBoost({ createContext: () => g.ctx, outputDeviceId: () => 'spk1' });
    expect(c.boost('k', {} as any, 1.5)).toBe(false);
  });
  it('retain() drops chains of tracks that went away', () => {
    const f = fakeCtx(); const b = new AudioBoost({ createContext: () => f.ctx });
    b.boost('x', {} as any, 1.5); b.boost('y', {} as any, 1.5); b.retain(new Set(['y']));
    expect(b.has('x')).toBe(false); expect(b.has('y')).toBe(true);
  });
});
