/**
 * Bitrate adaptation with hysteresis. libwebrtc's own estimator reacts to every dip, which shows up as a screen share whose
 * quality pumps up and down. The governor sits on top of it and moves the sender's bitrate cap along a ladder of steps with
 * asymmetric rules:
 *   - step DOWN quickly, but only after the trouble has lasted `downAfter` samples in a row (a single bad sample is ignored);
 *   - step UP slowly: `upAfter` consecutive healthy samples, with real headroom, and never within `minDwellMs` of the last move;
 *   - every step down that follows a recent step up doubles the wait before the next step up (flap penalty, capped).
 * It is pure (time is passed in) so it is tested with simulated sequences.
 */
export interface GovernorOptions {
  /** Consecutive troubled samples before stepping down. */
  downAfter: number;
  /** Consecutive healthy samples before stepping up. */
  upAfter: number;
  /** Minimum time between two moves. */
  minDwellMs: number;
  /** Extra wait before stepping up, doubled for every flap, up to this cap. */
  maxUpPenaltyMs: number;
  /** A step down within this time after a step up counts as a flap. */
  flapWindowMs: number;
  /** Packet loss (%) above which a sample is troubled / below which it is healthy. */
  lossBad: number; lossGood: number;
  /** Required available bandwidth versus the next step to go up (1.3 = 30% headroom). */
  headroom: number;
}
export const DEFAULT_GOVERNOR: GovernorOptions = { downAfter: 2, upAfter: 8, minDwellMs: 6_000, maxUpPenaltyMs: 60_000, flapWindowMs: 30_000, lossBad: 8, lossGood: 2, headroom: 1.3 };

export interface GovernorSignal {
  ts: number;
  /** libwebrtc qualityLimitationReason of the top layer: 'none' | 'bandwidth' | 'cpu' | 'other'. */
  limitation?: string;
  lossPct?: number | null;
  /** Estimated available outgoing bitrate (kbps), when the browser reports it. */
  availableKbps?: number | null;
}
export interface GovernorDecision { index: number; kbps: number; changed: boolean; reason?: 'congestion' | 'recovered' }

export class BitrateGovernor {
  private idx: number; private bad = 0; private good = 0; private lastMove = -Infinity; private lastUp = -Infinity; private lastDown = -Infinity; private penalty = 0;
  readonly steps: readonly number[];
  constructor(steps: readonly number[], private o: GovernorOptions = DEFAULT_GOVERNOR, start?: number) {
    this.steps = [...steps].sort((a, b) => a - b);
    if (!this.steps.length) throw new Error('BitrateGovernor needs at least one step');
    this.idx = start == null ? this.steps.length - 1 : Math.max(0, Math.min(this.steps.length - 1, start));
  }
  get index() { return this.idx; }
  get kbps() { return this.steps[this.idx]!; }
  reset(start = this.steps.length - 1) { this.idx = Math.max(0, Math.min(this.steps.length - 1, start)); this.bad = this.good = 0; this.lastMove = this.lastUp = this.lastDown = -Infinity; this.penalty = 0; }

  push(s: GovernorSignal): GovernorDecision {
    const o = this.o;
    const limited = s.limitation === 'bandwidth' || s.limitation === 'cpu';
    const lossy = (s.lossPct ?? 0) > o.lossBad;
    const starved = s.availableKbps != null && s.availableKbps < this.kbps * 0.85;
    const troubled = limited || lossy || starved;
    const next = this.steps[this.idx + 1];
    const roomy = next == null ? false : s.availableKbps == null ? true : s.availableKbps >= next * o.headroom;
    const healthy = !limited && (s.lossPct ?? 0) <= o.lossGood && !starved && roomy;
    if (troubled) { this.bad++; this.good = 0; } else if (healthy) { this.good++; this.bad = 0; } else { this.bad = 0; /* neutral: neither counts */ }
    // a long calm stretch (no step down for 3 flap windows) forgives earlier flaps
    if (this.penalty && s.ts - this.lastDown > o.flapWindowMs * 3) this.penalty = 0;
    const sinceMove = s.ts - this.lastMove;
    if (this.bad >= o.downAfter && this.idx > 0 && sinceMove >= o.minDwellMs / 2) {
      if (s.ts - this.lastUp < o.flapWindowMs) this.penalty = Math.min(o.maxUpPenaltyMs, this.penalty ? this.penalty * 2 : o.minDwellMs * 2);
      this.idx--; this.bad = 0; this.good = 0; this.lastMove = s.ts; this.lastDown = s.ts;
      return { index: this.idx, kbps: this.kbps, changed: true, reason: 'congestion' };
    }
    if (this.good >= o.upAfter && this.idx < this.steps.length - 1 && sinceMove >= o.minDwellMs + this.penalty) {
      this.idx++; this.good = 0; this.bad = 0; this.lastMove = s.ts; this.lastUp = s.ts;
      return { index: this.idx, kbps: this.kbps, changed: true, reason: 'recovered' };
    }
    return { index: this.idx, kbps: this.kbps, changed: false };
  }
}

/** Governor steps for a top bitrate: the top, then 70%, 45%, 28%, 18% of it (never below 400 kbps). */
export function bitrateLadder(topKbps: number): number[] {
  const out = new Set<number>();
  for (const f of [1, 0.7, 0.45, 0.28, 0.18]) { const v = Math.max(400, Math.round((topKbps * f) / 50) * 50); if (v <= topKbps) out.add(v); }
  out.add(Math.max(150, Math.min(topKbps, 400)));
  return [...out].sort((a, b) => a - b);
}

/** Pulls the signals the governor needs out of a publisher RTCStatsReport (pure; tolerant of missing fields). */
export function parseScreenSignals(report: { forEach(cb: (s: any) => void): void }, now: number): GovernorSignal {
  let top: any = null; let avail: number | null = null; let lossFrac: number | null = null;
  report.forEach((s: any) => {
    if (s.type === 'outbound-rtp' && (s.kind ?? s.mediaType) === 'video' && (!top || (s.frameWidth ?? 0) >= (top.frameWidth ?? 0))) top = s;
    else if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && typeof s.availableOutgoingBitrate === 'number') avail = Math.round(s.availableOutgoingBitrate / 1000);
    else if (s.type === 'remote-inbound-rtp' && (s.kind ?? s.mediaType) === 'video' && typeof s.fractionLost === 'number') lossFrac = Math.max(lossFrac ?? 0, s.fractionLost <= 1 ? s.fractionLost * 100 : (s.fractionLost / 255) * 100);
  });
  return { ts: now, limitation: top?.qualityLimitationReason, lossPct: lossFrac, availableKbps: avail };
}
