/**
 * Mic noise suppression: RNNoise (WASM, Apache-2.0, @timephy/rnnoise-wasm) running in an AudioWorklet, wrapped as a LiveKit
 * TrackProcessor so the *published* mic track is the denoised one. Everything is bundled locally (the worklet script URL is
 * injected by the host app via configureNoise(), because only the bundler can resolve `?worker&url`). No CDN.
 *
 * Every failure path resolves to `undefined` + a reason so the caller can fall back to the browser's built-in suppression.
 */
import type { TrackProcessor, Track } from 'livekit-client';
import { buildNoiseGraph, resolveNoiseTuning, type NoiseGraph, type NoiseGraphDeps, type NoiseTuning } from './noiseTuning';

export const NOISE_WORKLET_NAME = 'NoiseSuppressorWorklet';
export type NoiseFallbackReason = 'unsupported' | 'no-worklet-url' | 'load-failed' | 'start-failed' | 'underrun' | 'worklet-error';

let workletUrl: string | undefined;
/** Host app gives the URL of the bundled worklet script (Vite: import url from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url'). */
export function configureNoise(opts: { workletUrl?: string }) { workletUrl = opts.workletUrl; }

export function isRnnoiseSupported(g: any = globalThis): boolean {
  return typeof g.AudioContext === 'function' && typeof g.AudioWorkletNode === 'function' && typeof g.WebAssembly === 'object';
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('worklet load timed out')), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
export type RnnoiseResult =
  | { processor: RnnoiseProcessor; reason?: undefined }
  | { processor?: undefined; reason: NoiseFallbackReason; error?: unknown };

/** The LiveKit processor plus live tuning (wet/dry, gate) so the settings sliders apply without re-publishing the mic. */
export type RnnoiseProcessor = TrackProcessor<Track.Kind.Audio> & { setTuning(t: NoiseTuning): void };

export interface RnnoiseDeps {
  /** Test seam: defaults to the real globals. */
  AudioContextCtor?: any; AudioWorkletNodeCtor?: any; url?: string; supported?: boolean;
  graph?: NoiseGraphDeps;
}
export interface RnnoiseOptions {
  tuning?: NoiseTuning;
  /** Called when the worklet stalls or errors while running: the caller switches to the browser's suppression. */
  onFallback?: (reason: NoiseFallbackReason) => void;
}

export const DEFAULT_TUNING: NoiseTuning = resolveNoiseTuning('standard');

/** Builds the audio context with the worklet module loaded (shared by the call pipeline and the A/B listen test). */
export async function openNoiseContext(deps: RnnoiseDeps = {}): Promise<{ ctx: any; Worklet: any } | { reason: NoiseFallbackReason; error?: unknown }> {
  const Ctx = deps.AudioContextCtor ?? (globalThis as any).AudioContext;
  const Node = deps.AudioWorkletNodeCtor ?? (globalThis as any).AudioWorkletNode;
  if (!(deps.supported ?? isRnnoiseSupported())) return { reason: 'unsupported' };
  const url = deps.url ?? workletUrl;
  if (!url) return { reason: 'no-worklet-url' };
  try {
    const ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
    await withTimeout(ctx.audioWorklet.addModule(url), 10_000);
    return { ctx, Worklet: Node };
  } catch (error) { return { reason: 'load-failed', error }; }
}

/** Builds the processor. Loads the worklet module eagerly so a missing/blocked script fails here (-> fallback), not mid-call. */
export async function createRnnoiseProcessor(deps: RnnoiseDeps = {}, opts: RnnoiseOptions = {}): Promise<RnnoiseResult> {
  const opened = await openNoiseContext(deps);
  if ('reason' in opened) return opened;
  const { ctx, Worklet } = opened as { ctx: AudioContext; Worklet: any };
  let tuning = opts.tuning ?? DEFAULT_TUNING; let graph: NoiseGraph | undefined; let failed = false;
  const fail = (r: NoiseFallbackReason) => { if (failed) return; failed = true; opts.onFallback?.(r); };
  const teardown = () => { graph?.dispose(); graph = undefined; };
  const wire = async (input: MediaStreamTrack) => {
    teardown(); failed = false;
    // never await resume(): on a context created without a user gesture it stays pending forever
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    graph = buildNoiseGraph(ctx, Worklet, NOISE_WORKLET_NAME, input, tuning, { onUnderrun: () => fail('underrun'), onError: () => fail('worklet-error') }, deps.graph);
    proc.processedTrack = graph.output;
  };
  const proc: RnnoiseProcessor = {
    name: 'jv-rnnoise',
    processedTrack: undefined,
    async init(o: any) { await wire(o.track); },
    async restart(o: any) { await wire(o.track); },
    async destroy() { teardown(); proc.processedTrack?.stop(); proc.processedTrack = undefined; try { await ctx.close(); } catch { /* */ } },
    setTuning(t: NoiseTuning) { tuning = t; graph?.setTuning(t); },
  };
  return { processor: proc };
}
