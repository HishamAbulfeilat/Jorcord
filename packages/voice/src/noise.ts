/**
 * Mic noise suppression: RNNoise (WASM, Apache-2.0, @timephy/rnnoise-wasm) running in an AudioWorklet, wrapped as a LiveKit
 * TrackProcessor so the *published* mic track is the denoised one. Everything is bundled locally (the worklet script URL is
 * injected by the host app via configureNoise(), because only the bundler can resolve `?worker&url`). No CDN.
 *
 * Every failure path resolves to `undefined` + a reason so the caller can fall back to the browser's built-in suppression.
 */
import type { TrackProcessor, Track } from 'livekit-client';

export const NOISE_WORKLET_NAME = 'NoiseSuppressorWorklet';
export type NoiseFallbackReason = 'unsupported' | 'no-worklet-url' | 'load-failed' | 'start-failed';

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
  | { processor: TrackProcessor<Track.Kind.Audio>; reason?: undefined }
  | { processor?: undefined; reason: NoiseFallbackReason; error?: unknown };

export interface RnnoiseDeps {
  /** Test seam: defaults to the real globals. */
  AudioContextCtor?: any; AudioWorkletNodeCtor?: any; url?: string; supported?: boolean;
}

/** Builds the processor. Loads the worklet module eagerly so a missing/blocked script fails here (-> fallback), not mid-call. */
export async function createRnnoiseProcessor(deps: RnnoiseDeps = {}): Promise<RnnoiseResult> {
  const Ctx = deps.AudioContextCtor ?? (globalThis as any).AudioContext;
  const Node = deps.AudioWorkletNodeCtor ?? (globalThis as any).AudioWorkletNode;
  if (!(deps.supported ?? isRnnoiseSupported())) return { reason: 'unsupported' };
  const url = deps.url ?? workletUrl;
  if (!url) return { reason: 'no-worklet-url' };

  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
    await withTimeout(ctx.audioWorklet.addModule(url), 10_000);
  } catch (error) { return { reason: 'load-failed', error }; }

  let src: MediaStreamAudioSourceNode | undefined; let node: AudioWorkletNode | undefined; let dest: MediaStreamAudioDestinationNode | undefined;
  const teardown = () => {
    try { src?.disconnect(); } catch { /* */ } try { node?.disconnect(); } catch { /* */ } try { dest?.disconnect(); } catch { /* */ }
    src = node = dest = undefined;
  };
  const wire = async (input: MediaStreamTrack) => {
    teardown();
    // never await resume(): on a context created without a user gesture it stays pending forever
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    src = ctx.createMediaStreamSource(new MediaStream([input]));
    node = new Node(ctx, NOISE_WORKLET_NAME, { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    dest = ctx.createMediaStreamDestination();
    src.connect(node!); node!.connect(dest);
    proc.processedTrack = dest.stream.getAudioTracks()[0];
  };
  const proc: TrackProcessor<Track.Kind.Audio> = {
    name: 'jv-rnnoise',
    processedTrack: undefined,
    async init(opts: any) { await wire(opts.track); },
    async restart(opts: any) { await wire(opts.track); },
    async destroy() { teardown(); proc.processedTrack?.stop(); proc.processedTrack = undefined; try { await ctx.close(); } catch { /* */ } },
  };
  return { processor: proc };
}
