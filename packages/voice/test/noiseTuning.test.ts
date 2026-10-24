import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUDIO, resolveAudio } from '../src/audio';
import { UnderrunDetector, WORKLET_DELAY_S, applyNoiseStrength, buildNoiseGraph, gateDecide, initialGate, resolveNoiseTuning, rmsDb } from '../src/noiseTuning';
import { createRnnoiseProcessor } from '../src/noise';

describe('noise strength -> tuning', () => {
  it('off is dry, light is a partial mix, standard gates gently, strong is fully wet with a firmer gate and browser help', () => {
    const t = (s: any) => resolveNoiseTuning(s);
    expect(t('off')).toMatchObject({ wet: 0, gate: null, browserAssist: false });
    expect(t('light')).toMatchObject({ wet: 0.6, gate: null });
    const std = t('standard'), strong = t('strong');
    expect(std.wet).toBeLessThan(1); expect(std.gate!.floorGain).toBeGreaterThan(strong.gate!.floorGain);
    expect(strong).toMatchObject({ wet: 1, browserAssist: true }); expect(strong.gate!.thresholdDb).toBeGreaterThan(std.gate!.thresholdDb);
  });
  it('never hard-mutes (floor above zero) and always looks ahead of the gate', () => {
    for (const s of ['standard', 'strong'] as const) { const g = resolveNoiseTuning(s).gate!; expect(g.floorGain).toBeGreaterThan(0); expect(g.lookaheadMs).toBeGreaterThanOrEqual(10); expect(g.holdMs).toBeGreaterThanOrEqual(150); expect(g.attackMs).toBeLessThanOrEqual(8); }
  });
  it('manual wet/dry override wins and is clamped; off ignores it', () => {
    expect(resolveNoiseTuning('standard', 0.3).wet).toBe(0.3);
    expect(resolveNoiseTuning('strong', 7).wet).toBe(1);
    expect(resolveNoiseTuning('standard', -2).wet).toBe(0);
    expect(resolveNoiseTuning('off', 0.9).wet).toBe(0);
  });
  it('strength selection keeps suppression flag and engine mode consistent', () => {
    expect(applyNoiseStrength('off')).toMatchObject({ noiseSuppression: false, noiseSuppressionMode: 'off' });
    expect(applyNoiseStrength('light')).toMatchObject({ noiseSuppression: true, noiseSuppressionMode: 'rnnoise' });
    expect(applyNoiseStrength('strong')).toMatchObject({ noiseSuppression: true, noiseSuppressionMode: 'high' });
  });
  it('flows through resolveAudio; strength off disables the worklet; echo cancellation / AGC stay independent toggles', () => {
    const r = resolveAudio({ ...DEFAULT_AUDIO, ...applyNoiseStrength('strong'), noiseMix: 0.5, echoCancellation: false, autoGainControl: true });
    expect(r.useRnnoise).toBe(true); expect(r.noiseTuning.wet).toBe(0.5);
    expect(r.capture).toMatchObject({ echoCancellation: false, autoGainControl: true, noiseSuppression: true });
    expect(resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: 'rnnoise', noiseStrength: 'off' }).useRnnoise).toBe(false);
  });
});

describe('gate', () => {
  const p = resolveNoiseTuning('standard').gate!;
  it('opens at once on speech, holds through short gaps, then closes to the floor with a slow release', () => {
    let st = initialGate(0);
    let d = gateDecide(st, -80, p, 20); st = d.state;           // quiet, but hold from the start keeps it open at first
    d = gateDecide(st, -30, p, 40); st = d.state;
    expect(d).toMatchObject({ target: 1, tauMs: p.attackMs });
    d = gateDecide(st, -80, p, 60); st = d.state;               // gap inside the hold window
    expect(d.target).toBe(1);
    let t = 60; for (; t < 40 + p.holdMs; t += 10) { d = gateDecide(st, -80, p, t); st = d.state; }
    d = gateDecide(st, -80, p, t + 200 > 400 ? 40 + p.holdMs + 10 : t); // hold over
    let closed = d;
    for (let k = 0; k < 5 && closed.target === 1; k++) { t += 10; closed = gateDecide(closed.state, -80, p, 40 + p.holdMs + 20 + k * 10); }
    expect(closed).toMatchObject({ target: p.floorGain, tauMs: p.releaseMs });
  });
  it('has hysteresis: a level between the close and open thresholds does not chatter', () => {
    let st = initialGate(0); let d = gateDecide(st, -30, p, 10); st = d.state;
    const mid = p.thresholdDb - p.closeHysteresisDb / 2; // below open, above close
    for (let t = 20; t < 1000; t += 10) { d = gateDecide(st, mid, p, t); st = d.state; expect(d.target).toBe(1); }
  });
  it('watchdog: if updates stall (throttled timer) the gate is forced open', () => {
    let st = initialGate(0); let d = gateDecide(st, -90, p, 10); st = d.state;
    for (let t = 20; t < 1000; t += 10) { d = gateDecide(st, -90, p, t); st = d.state; }
    expect(d.target).toBe(p.floorGain);
    expect(gateDecide(st, -90, p, 1000 + 5000).target).toBe(1);
  });
  it('rmsDb measures level', () => {
    expect(rmsDb(new Float32Array(100))).toBe(-120);
    expect(rmsDb(new Float32Array(100).fill(0.5))).toBeCloseTo(-6.02, 1);
  });
});

describe('UnderrunDetector', () => {
  it('stays quiet while the worklet output follows the input, or the input is silent', () => {
    const u = new UnderrunDetector(); let hit = false;
    for (let t = 0; t < 5000; t += 20) hit ||= u.push(-20, -22, t);
    for (let t = 5000; t < 9000; t += 20) hit ||= u.push(-90, -120, t);
    expect(hit).toBe(false);
  });
  it('fires when the output is silent under active input for a sustained stall', () => {
    const u = new UnderrunDetector(); let at = -1;
    for (let t = 0; t < 3000 && at < 0; t += 20) if (u.push(-20, -120, t)) at = t;
    expect(at).toBeGreaterThanOrEqual(800); expect(at).toBeLessThan(900);
  });
  it('fires on repeated short dropouts (choppy) but not on one', () => {
    const one = new UnderrunDetector(); let hit = false;
    for (let t = 0; t < 400; t += 20) hit ||= one.push(-20, t >= 100 && t < 200 ? -120 : -20, t);
    expect(hit).toBe(false);
    const many = new UnderrunDetector(); hit = false;
    for (let t = 0, k = 0; t < 5000; t += 20) { const gap = t % 500 >= 100 && t % 500 < 200; hit ||= many.push(-20, gap ? -120 : -20, t); k++; }
    expect(hit).toBe(true);
  });
});

function fakeCtx() {
  const mk = (extra: any = {}) => { const n: any = { connect: vi.fn((x) => x), disconnect: vi.fn(), ...extra }; return n; };
  const analysers: any[] = []; const gains: any[] = []; const delays: any[] = [];
  const ctx: any = {
    currentTime: 1,
    createMediaStreamSource: vi.fn(() => mk()),
    createGain: vi.fn(() => { const g = mk({ gain: { value: 1, setTargetAtTime: vi.fn() } }); gains.push(g); return g; }),
    createDelay: vi.fn(() => { const d = mk({ delayTime: { value: 0 } }); delays.push(d); return d; }),
    createAnalyser: vi.fn(() => { const a = mk({ fftSize: 0, level: 0.1, getFloatTimeDomainData(b: Float32Array) { b.fill(this.level); } }); analysers.push(a); return a; }),
    createMediaStreamDestination: vi.fn(() => mk({ stream: { getAudioTracks: () => [{ stop: vi.fn() }] } })),
  };
  class Worklet { onprocessorerror: any; connect = vi.fn((x: any) => x); disconnect = vi.fn(); constructor(public c: any, public name: string, public o: any) { worklets.push(this); } }
  const worklets: any[] = [];
  (globalThis as any).MediaStream = class { constructor(public tracks: any[]) {} };
  return { ctx, Worklet, analysers, gains, delays, worklets };
}

describe('buildNoiseGraph', () => {
  it('mixes wet and delay-compensated dry, looks ahead of the gate, and retunes live', () => {
    const f = fakeCtx(); let tick = () => {}; let clock = 0;
    const g = buildNoiseGraph(f.ctx, f.Worklet, 'W', {} as any, resolveNoiseTuning('standard'), {}, { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {}, now: () => clock });
    const [wet, dry, mix, gate] = f.gains;
    expect(wet.gain.value).toBeCloseTo(0.88); expect(dry.gain.value).toBeCloseTo(0.12);
    expect(f.delays[0].delayTime.value).toBeCloseTo(WORKLET_DELAY_S);   // dry path matches the worklet delay: no comb filtering
    expect(f.delays[1].delayTime.value).toBeCloseTo(resolveNoiseTuning('standard').gate!.lookaheadMs / 1000);
    expect(mix).toBeDefined(); expect(g.output).toBeDefined();
    clock = 10; tick();
    expect(gate.gain.setTargetAtTime).toHaveBeenCalledWith(1, 1, expect.any(Number)); // loud mix (0.1 => -20 dB): gate open
    g.setTuning(resolveNoiseTuning('light'));
    expect(wet.gain.value).toBeCloseTo(0.6); expect(dry.gain.value).toBeCloseTo(0.4); expect(f.delays[1].delayTime.value).toBe(0);
    g.dispose(); expect(f.worklets[0].disconnect).toHaveBeenCalled();
  });
  it('reports an underrun when the worklet output goes silent under active input', () => {
    const f = fakeCtx(); let tick = () => {}; let clock = 0; const onUnderrun = vi.fn();
    buildNoiseGraph(f.ctx, f.Worklet, 'W', {} as any, resolveNoiseTuning('standard'), { onUnderrun }, { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {}, now: () => clock });
    const wetAn = f.analysers[2]; wetAn.level = 0; // input analyser keeps 0.1
    for (clock = 0; clock < 1200; clock += 20) tick();
    expect(onUnderrun).toHaveBeenCalledTimes(1);
  });
  it('forwards worklet processor errors', () => {
    const f = fakeCtx(); const onError = vi.fn();
    buildNoiseGraph(f.ctx, f.Worklet, 'W', {} as any, resolveNoiseTuning('standard'), { onError }, { setInterval: () => 1, clearInterval: () => {} });
    f.worklets[0].onprocessorerror(new Error('boom'));
    expect(onError).toHaveBeenCalled();
  });
});

describe('processor fallback to browser suppression', () => {
  it('calls onFallback("underrun") once when the worklet stalls and exposes live setTuning', async () => {
    const f = fakeCtx(); let tick = () => {}; let clock = 0; const onFallback = vi.fn();
    const Ctx = vi.fn(function () { return Object.assign(f.ctx, { state: 'running', resume: async () => {}, close: vi.fn(async () => {}), audioWorklet: { addModule: async () => {} } }); });
    const r = await createRnnoiseProcessor({ AudioContextCtor: Ctx, AudioWorkletNodeCtor: f.Worklet, url: '/w.js', supported: true, graph: { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {}, now: () => clock } }, { tuning: resolveNoiseTuning('strong'), onFallback });
    await r.processor!.init({ track: {} } as any);
    f.analysers[2].level = 0;
    for (clock = 0; clock < 3000; clock += 20) tick();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('underrun');
    r.processor!.setTuning(resolveNoiseTuning('light'));
    expect(f.gains[0].gain.value).toBeCloseTo(0.6);
  });
});
