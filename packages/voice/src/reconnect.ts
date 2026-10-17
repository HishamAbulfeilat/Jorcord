/**
 * Pure reconnect state machine for a voice session (no timers, no I/O: the client drives it).
 *
 * idle -> connecting -> connected
 * connected -> resuming (LiveKit's own ICE/signal resume) -> connected
 * connected|resuming -> waiting (room dropped; backoff) -> rejoining (fresh token + new connect) -> connected | waiting | failed
 */
export type ReconnectPhase = 'idle' | 'connecting' | 'connected' | 'resuming' | 'waiting' | 'rejoining' | 'failed';
export type LossReason = 'network' | 'server' | 'removed' | 'token' | 'unknown';

export interface BackoffOptions { baseMs: number; maxMs: number; factor: number }
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 15_000, factor: 2 };
export const DEFAULT_MAX_ATTEMPTS = 20;

/** Delay before retry number `attempt` (1-based): base * factor^(attempt-1), capped. `jitter` (0..1) spreads clients out. */
export function backoffDelay(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF, jitter = 0, rnd: () => number = Math.random): number {
  const raw = Math.min(o.maxMs, o.baseMs * Math.pow(o.factor, Math.max(0, attempt - 1)));
  return Math.round(raw * (1 - jitter / 2 + rnd() * jitter));
}

export interface ReconnectState {
  phase: ReconnectPhase;
  /** Rejoin attempt in progress / waiting to run (0 when none). */
  attempt: number; maxAttempts: number;
  /** Backoff before the next attempt while `waiting`. */
  delayMs: number;
  reason: LossReason | null;
  /** The user still wants to be in the channel. */
  wanted: boolean;
}

export type ReconnectEvent =
  | { type: 'want' }
  | { type: 'connected' }
  | { type: 'resuming' }
  | { type: 'lost'; reason: LossReason }
  | { type: 'attempt-start' }
  | { type: 'attempt-failed'; fatal?: boolean }
  | { type: 'retry-now' }
  | { type: 'leave' };

export const initialReconnect = (maxAttempts = DEFAULT_MAX_ATTEMPTS): ReconnectState => ({ phase: 'idle', attempt: 0, maxAttempts, delayMs: 0, reason: null, wanted: false });

export function reconnectReducer(s: ReconnectState, e: ReconnectEvent, backoff: BackoffOptions = DEFAULT_BACKOFF): ReconnectState {
  switch (e.type) {
    case 'want': return { ...s, phase: 'connecting', attempt: 0, delayMs: 0, reason: null, wanted: true };
    case 'connected': return s.wanted ? { ...s, phase: 'connected', attempt: 0, delayMs: 0, reason: null } : s;
    case 'resuming': return s.wanted && (s.phase === 'connected' || s.phase === 'resuming') ? { ...s, phase: 'resuming' } : s;
    case 'lost':
      if (!s.wanted) return s;
      // being removed by a moderator / replaced by another session is final; a bad token is retried once with a new one (see attempt-failed)
      if (e.reason === 'removed') return { ...s, phase: 'idle', wanted: false, reason: e.reason, attempt: 0, delayMs: 0 };
      return { ...s, phase: 'waiting', attempt: 1, delayMs: backoffDelay(1, backoff), reason: e.reason };
    case 'attempt-start': return s.wanted && (s.phase === 'waiting' || s.phase === 'rejoining') ? { ...s, phase: 'rejoining', delayMs: 0 } : s;
    case 'attempt-failed': {
      if (!s.wanted) return s;
      if (e.fatal || s.attempt >= s.maxAttempts) return { ...s, phase: 'failed', wanted: false, delayMs: 0 };
      const attempt = s.attempt + 1;
      return { ...s, phase: 'waiting', attempt, delayMs: backoffDelay(attempt, backoff) };
    }
    case 'retry-now':
      if (s.phase === 'waiting') return { ...s, phase: 'rejoining', delayMs: 0 };
      if (s.phase === 'failed') return { ...s, phase: 'rejoining', attempt: 1, wanted: true, delayMs: 0, reason: s.reason };
      return s;
    case 'leave': return { ...initialReconnect(s.maxAttempts) };
  }
}

/** Maps the machine onto the coarse status the UI switches on. */
export function statusOf(p: ReconnectPhase): 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' {
  switch (p) {
    case 'idle': return 'idle';
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    case 'failed': return 'disconnected';
    default: return 'reconnecting';
  }
}

/** LiveKit DisconnectReason numbers: 2 duplicate identity, 4 participant removed, 5 room deleted, 10 room closed. */
export function lossReasonOf(reason: number | undefined): LossReason {
  switch (reason) {
    case 2: case 4: case 5: case 10: return 'removed';
    case 3: case 6: case 8: case 9: return 'server';
    case 1: return 'network';
    default: return 'unknown';
  }
}
