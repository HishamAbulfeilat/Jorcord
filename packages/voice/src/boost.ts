/**
 * Listening volume above 100 %. HTMLMediaElement.volume is capped at 1 (and the room runs with webAudioMix: false for
 * setSinkId/iOS reliability), so a boosted remote track is additionally routed through a GainNode while its <audio> element
 * stays attached at volume 0 (Chrome only decodes remote WebRTC audio that is attached to an element).
 * Everything degrades to "plain element volume, capped at 100 %" when Web Audio is unavailable, suspended, or the output
 * device cannot be honoured.
 */
export interface BoostDeps {
  createContext?: () => AudioContext;
  /** Chosen speaker device id ('' / undefined = default). */
  outputDeviceId?: () => string | undefined;
}

interface Chain { track: MediaStreamTrack; src: MediaStreamAudioSourceNode; gain: GainNode }

export class AudioBoost {
  private ctx: AudioContext | undefined;
  private chains = new Map<string, Chain>();
  private sinkApplied: string | undefined;
  constructor(private deps: BoostDeps = {}) {}

  private context(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    try {
      const make = this.deps.createContext ?? (typeof AudioContext === 'function' ? () => new AudioContext() : undefined);
      this.ctx = make?.();
    } catch { this.ctx = undefined; }
    return this.ctx;
  }

  /**
   * Sets the gain (>1) for one track. Returns true when the boost is live, in which case the caller must silence the element
   * (volume 0). False means "not boosted": the caller uses element volume min(1, v) instead.
   */
  boost(key: string, track: MediaStreamTrack, gain: number): boolean {
    const ctx = this.context();
    if (!ctx) return false;
    const dev = this.deps.outputDeviceId?.() || undefined;
    const anyCtx = ctx as any;
    if (dev && typeof anyCtx.setSinkId !== 'function') return false; // would play on the wrong device
    if (ctx.state !== 'running') { void ctx.resume?.().catch?.(() => {}); if ((ctx.state as string) !== 'running') return false; }
    if ((dev ?? '') !== (this.sinkApplied ?? '') && typeof anyCtx.setSinkId === 'function') {
      this.sinkApplied = dev ?? '';
      void Promise.resolve(anyCtx.setSinkId(dev ?? '')).catch(() => {});
    }
    let c = this.chains.get(key);
    if (c && c.track !== track) { this.release(key); c = undefined; }
    if (!c) {
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const g = ctx.createGain();
        src.connect(g); g.connect(ctx.destination);
        c = { track, src, gain: g };
        this.chains.set(key, c);
      } catch { return false; }
    }
    c.gain.gain.value = gain;
    return true;
  }

  release(key: string) {
    const c = this.chains.get(key); if (!c) return;
    try { c.src.disconnect(); c.gain.disconnect(); } catch { /* */ }
    this.chains.delete(key);
  }
  releaseAll() { for (const k of [...this.chains.keys()]) this.release(k); }
  /** Keep only chains for these keys (tracks that went away). */
  retain(keys: Set<string>) { for (const k of [...this.chains.keys()]) if (!keys.has(k)) this.release(k); }
  has(key: string) { return this.chains.has(key); }

  async close() { this.releaseAll(); const c = this.ctx; this.ctx = undefined; try { await c?.close(); } catch { /* */ } }
}
