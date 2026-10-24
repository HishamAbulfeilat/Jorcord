import { describe, it, expect, vi } from 'vitest';
import { createRnnoiseProcessor, configureNoise, isRnnoiseSupported, NOISE_WORKLET_NAME } from '../src/noise';
import { resolveAudio, DEFAULT_AUDIO } from '../src/audio';

function fakeAudio(opts: { addModule?: () => Promise<void> } = {}) {
  const nodes: any[] = [];
  const mkNode = () => { const n: any = { connect: vi.fn((x) => x), disconnect: vi.fn() }; nodes.push(n); return n; };
  const outTrack = { stop: vi.fn(), kind: 'audio' };
  const ctx: any = {
    state: 'running', resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    audioWorklet: { addModule: vi.fn(opts.addModule ?? (async () => {})) },
    currentTime: 0,
    createMediaStreamSource: vi.fn(() => mkNode()),
    createGain: vi.fn(() => Object.assign(mkNode(), { gain: { value: 1, setTargetAtTime: vi.fn() } })),
    createDelay: vi.fn(() => Object.assign(mkNode(), { delayTime: { value: 0 } })),
    createAnalyser: vi.fn(() => Object.assign(mkNode(), { fftSize: 0, getFloatTimeDomainData: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => Object.assign(mkNode(), { stream: { getAudioTracks: () => [outTrack] } })),
  };
  const worklets: any[] = [];
  class Worklet { constructor(public ctx: any, public name: string, public o: any) { Object.assign(this, mkNode()); worklets.push(this); } }
  const Ctx = vi.fn(function () { return ctx; });
  (globalThis as any).MediaStream = class { constructor(public tracks: any[]) {} };
  return { ctx, Ctx, Worklet, worklets, outTrack };
}

describe('noise modes -> audio resolution', () => {
  it('standard = RNNoise only, high = RNNoise + browser constraint, browser = constraint only', () => {
    const r = (m: any) => resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: m });
    expect(r('off')).toMatchObject({ useRnnoise: false, capture: { noiseSuppression: false } });
    expect(r('browser')).toMatchObject({ useRnnoise: false, capture: { noiseSuppression: true } });
    expect(r('rnnoise')).toMatchObject({ useRnnoise: true, capture: { noiseSuppression: false } });
    expect(r('high')).toMatchObject({ useRnnoise: true, capture: { noiseSuppression: true } });
  });
  it('skips RNNoise in music mode and when suppression is switched off', () => {
    expect(resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: 'high', musicMode: true }).useRnnoise).toBe(false);
    expect(resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: 'rnnoise', noiseSuppression: false }).useRnnoise).toBe(false);
  });
});

describe('createRnnoiseProcessor', () => {
  it('reports unsupported / missing url instead of throwing', async () => {
    expect(await createRnnoiseProcessor({ supported: false, url: '/x.js' })).toEqual({ reason: 'unsupported' });
    configureNoise({ workletUrl: undefined });
    expect(await createRnnoiseProcessor({ supported: true })).toEqual({ reason: 'no-worklet-url' });
    expect(isRnnoiseSupported({})).toBe(false);
  });
  it('reports load-failed when the worklet module cannot be added', async () => {
    const f = fakeAudio({ addModule: async () => { throw new Error('blocked by CSP'); } });
    const r = await createRnnoiseProcessor({ AudioContextCtor: f.Ctx, AudioWorkletNodeCtor: f.Worklet, url: '/w.js', supported: true });
    expect(r.reason).toBe('load-failed');
  });
  it('wires source -> worklet -> destination and publishes the processed track', async () => {
    const f = fakeAudio();
    const r = await createRnnoiseProcessor({ AudioContextCtor: f.Ctx, AudioWorkletNodeCtor: f.Worklet, url: '/w.js', supported: true, graph: { setInterval: () => 0, clearInterval: () => {} } });
    expect(r.processor).toBeDefined();
    const p = r.processor!;
    expect(f.ctx.audioWorklet.addModule).toHaveBeenCalledWith('/w.js');
    expect(f.Ctx).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 48000 }));
    await p.init({ track: { id: 'mic' } } as any);
    expect(f.worklets[0].name).toBe(NOISE_WORKLET_NAME);
    expect(f.worklets[0].o).toMatchObject({ outputChannelCount: [1] });
    expect(p.processedTrack).toBe(f.outTrack);
    await p.restart!({ track: { id: 'mic2' } } as any);
    expect(f.worklets.length).toBe(2);
    await p.destroy();
    expect(f.outTrack.stop).toHaveBeenCalled(); expect(f.ctx.close).toHaveBeenCalled(); expect(p.processedTrack).toBeUndefined();
  });
});
