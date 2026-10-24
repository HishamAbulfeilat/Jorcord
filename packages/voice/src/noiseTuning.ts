/**
 * RNNoise tuning that avoids the "robotic" sound. Raw RNNoise output at 100% wet clips word onsets and pumps between words;
 * Jorcord therefore (a) mixes a little delay-compensated dry signal back in (wet/dry), (b) gates with LOOKAHEAD, so the gate has
 * opened before the first syllable reaches the output, with hold + slow release and a floor above zero (never a hard mute), and
 * (c) watches the worklet: if it underruns or dies, the caller falls back to the browser's own suppression.
 *
 * The decision logic here is pure and unit tested; `buildNoiseGraph` is the thin Web Audio glue, driven through an injected
 * context so tests can use fakes.
 */
export type NoiseStrength = 'off' | 'light' | 'standard' | 'strong';
export const NOISE_STRENGTHS: readonly NoiseStrength[] = ['off', 'light', 'standard', 'strong'];

export interface GateParams {
  /** Level (dBFS, RMS of the denoised signal) above which the gate opens. */
  thresholdDb: number;
  /** The gate closes only below threshold minus this (Schmitt trigger: no chatter around the threshold). */
  closeHysteresisDb: number;
  /** Stays open at least this long after the last loud sample (bridges the gaps between words). */
  holdMs: number;
  attackMs: number; releaseMs: number;
  /** Gain when closed (0..1). Above zero so the gate attenuates instead of cutting. */
  floorGain: number;
  /** The audio is delayed by this much so the gate can open before the speech arrives. */
  lookaheadMs: number;
}

export interface NoiseTuning {
  strength: NoiseStrength;
  /** 0..1 share of the RNNoise output in the mix; the rest is delay-compensated dry signal. */
  wet: number;
  gate: GateParams | null;
  /** Ask the browser's own suppression to help (only for the strongest setting). */
  browserAssist: boolean;
}

/** RNNoise works on 10 ms frames; the worklet adds about one frame of delay that the dry path has to match. */
export const WORKLET_DELAY_S = 0.01;

const GENTLE_GATE: GateParams = { thresholdDb: -58, closeHysteresisDb: 5, holdMs: 220, attackMs: 4, releaseMs: 260, floorGain: 0.35, lookaheadMs: 12 };
const FIRM_GATE: GateParams = { thresholdDb: -50, closeHysteresisDb: 5, holdMs: 280, attackMs: 4, releaseMs: 320, floorGain: 0.12, lookaheadMs: 15 };

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** strength (+ optional manual wet override) -> concrete mix and gate. `off` returns null-ish tuning (wet 0, no gate). */
export function resolveNoiseTuning(strength: NoiseStrength, mixOverride?: number | null): NoiseTuning {
  const base: NoiseTuning =
    strength === 'off' ? { strength, wet: 0, gate: null, browserAssist: false }
    : strength === 'light' ? { strength, wet: 0.6, gate: null, browserAssist: false }
    : strength === 'standard' ? { strength, wet: 0.88, gate: GENTLE_GATE, browserAssist: false }
    : { strength: 'strong', wet: 1, gate: FIRM_GATE, browserAssist: true };
  return mixOverride == null || strength === 'off' ? base : { ...base, wet: clamp01(mixOverride) };
}

/** Settings fields that follow from picking a strength in the UI (keeps `noiseSuppression` and the engine mode consistent). */
export function applyNoiseStrength(strength: NoiseStrength): { noiseSuppression: boolean; noiseSuppressionMode: 'off' | 'rnnoise' | 'high'; noiseStrength: NoiseStrength } {
  return strength === 'off' ? { noiseSuppression: false, noiseSuppressionMode: 'off', noiseStrength: strength }
    : { noiseSuppression: true, noiseSuppressionMode: strength === 'strong' ? 'high' : 'rnnoise', noiseStrength: strength };
}

// ---------------------------------------------------------------- gate
export interface GateState { open: boolean; holdUntil: number; lastTs: number }
export const initialGate = (now: number): GateState => ({ open: true, holdUntil: now, lastTs: now });
export interface GateDecision { state: GateState; target: number; tauMs: number }

/**
 * One gate update from the measured level. A watchdog opens the gate fully when updates stall (background-tab timer throttling),
 * so audio can never get stuck muted.
 */
export function gateDecide(st: GateState, levelDb: number, p: GateParams, now: number): GateDecision {
  if (now - st.lastTs > 250) return { state: { open: true, holdUntil: now + p.holdMs, lastTs: now }, target: 1, tauMs: p.attackMs };
  let open = st.open, holdUntil = st.holdUntil;
  if (levelDb >= p.thresholdDb) { open = true; holdUntil = now + p.holdMs; }
  else if (open && levelDb < p.thresholdDb - p.closeHysteresisDb && now >= holdUntil) open = false;
  return { state: { open, holdUntil, lastTs: now }, target: open ? 1 : p.floorGain, tauMs: open ? p.attackMs : p.releaseMs };
}

export const rmsDb = (buf: ArrayLike<number>): number => {
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  const r = Math.sqrt(s / Math.max(1, buf.length));
  return r > 1e-9 ? 20 * Math.log10(r) : -120;
};

// ---------------------------------------------------------------- underrun detection
export type UnderrunReason = 'underrun';
/**
 * The denoised signal must follow the input. Input clearly active while the worklet output is digital silence means the
 * worklet stalled (CPU starved, main-thread-blocked WASM, crashed): continuous for `stallMs`, or `dropouts` short gaps within `windowMs`.
 */
export class UnderrunDetector {
  private silentSince: number | null = null; private gaps: number[] = []; private gapOpen = false;
  constructor(private o = { activeDb: -45, silentDb: -85, stallMs: 800, minGapMs: 60, dropouts: 4, windowMs: 5_000 }) {}
  /** Returns true once when an underrun is established. */
  push(inputDb: number, wetDb: number, now: number): boolean {
    const bad = inputDb > this.o.activeDb && wetDb < this.o.silentDb;
    if (bad) {
      this.silentSince ??= now;
      if (now - this.silentSince >= this.o.stallMs) return true;
      if (!this.gapOpen && now - this.silentSince >= this.o.minGapMs) { this.gapOpen = true; this.gaps.push(now); }
    } else { this.silentSince = null; this.gapOpen = false; }
    this.gaps = this.gaps.filter((t) => now - t <= this.o.windowMs);
    return this.gaps.length >= this.o.dropouts;
  }
  reset() { this.silentSince = null; this.gaps = []; this.gapOpen = false; }
}

// ---------------------------------------------------------------- graph
export interface NoiseGraphHooks { onUnderrun?: () => void; onError?: (e: unknown) => void }
export interface NoiseGraphDeps {
  /** Test seams. */
  setInterval?: (fn: () => void, ms: number) => any; clearInterval?: (h: any) => void; now?: () => number; intervalMs?: number;
}
export interface NoiseGraph {
  /** Processed track for publishing (absent when a `sink` was given). */
  output: MediaStreamTrack | undefined;
  setTuning(t: NoiseTuning): void;
  dispose(): void;
}

/**
 *  input -> worklet(RNNoise) -> wetGain ─┐
 *        -> dryDelay(10ms) -> dryGain ───┴-> mix -> lookahead delay -> gateGain -> destination/sink
 *  mix -> analyser (gate + underrun measurements; reads the same signal that is about to be delayed)
 */
export function buildNoiseGraph(ctx: any, Worklet: any, workletName: string, input: MediaStreamTrack, tuning: NoiseTuning, hooks: NoiseGraphHooks = {}, deps: NoiseGraphDeps = {}, sink?: AudioNode): NoiseGraph {
  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms)); const clrIv = deps.clearInterval ?? ((h) => clearInterval(h)); const now = deps.now ?? (() => Date.now());
  const src = ctx.createMediaStreamSource(new MediaStream([input]));
  const node = new Worklet(ctx, workletName, { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
  const wetGain = ctx.createGain(); const dryDelay = ctx.createDelay(0.1); dryDelay.delayTime.value = WORKLET_DELAY_S; const dryGain = ctx.createGain();
  const mix = ctx.createGain(); const look = ctx.createDelay(0.1); const gateGain = ctx.createGain();
  const inAn = ctx.createAnalyser(); const mixAn = ctx.createAnalyser(); const wetAn = ctx.createAnalyser();
  for (const a of [inAn, mixAn, wetAn]) a.fftSize = 512;
  const dest = sink ? null : ctx.createMediaStreamDestination();
  src.connect(node); node.connect(wetGain); wetGain.connect(mix); node.connect(wetAn);
  src.connect(dryDelay); dryDelay.connect(dryGain); dryGain.connect(mix);
  src.connect(inAn); mix.connect(mixAn); mix.connect(look); look.connect(gateGain); gateGain.connect(sink ?? dest);
  let cur = tuning; let gate = initialGate(now()); let disposed = false; const under = new UnderrunDetector();
  const apply = (t: NoiseTuning) => {
    cur = t;
    // equal-power-ish: wet and dry add up to unity gain for correlated speech
    wetGain.gain.value = t.wet; dryGain.gain.value = 1 - t.wet;
    look.delayTime.value = t.gate ? t.gate.lookaheadMs / 1000 : 0;
    if (!t.gate) gateGain.gain.value = 1;
    gate = initialGate(now());
  };
  apply(tuning);
  const buf = new Float32Array(512); const inBuf = new Float32Array(512); const wetBuf = new Float32Array(512);
  node.onprocessorerror = (e: unknown) => { hooks.onError?.(e); };
  const tick = () => {
    if (disposed) return;
    try {
      mixAn.getFloatTimeDomainData(buf); inAn.getFloatTimeDomainData(inBuf); wetAn.getFloatTimeDomainData(wetBuf);
      const t = now();
      if (under.push(rmsDb(inBuf), rmsDb(wetBuf), t)) { under.reset(); hooks.onUnderrun?.(); return; }
      if (cur.gate) {
        const d = gateDecide(gate, rmsDb(buf), cur.gate, t); gate = d.state;
        gateGain.gain.setTargetAtTime(d.target, ctx.currentTime, d.tauMs / 1000 / 3);
      }
    } catch (e) { hooks.onError?.(e); }
  };
  const timer = setIv(tick, deps.intervalMs ?? 10);
  return {
    output: dest?.stream.getAudioTracks()[0],
    setTuning: apply,
    dispose() {
      disposed = true; clrIv(timer);
      for (const n of [src, node, wetGain, dryDelay, dryGain, mix, look, gateGain, inAn, mixAn, wetAn, dest]) { try { n?.disconnect(); } catch { /* */ } }
    },
  };
}
