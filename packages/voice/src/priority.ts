/** Priority speaker ducking: others' volume is multiplied by this factor while a priority speaker is talking. */
export const DUCK_FACTOR = 0.3;
export function effectiveVolume(base: number, opts: { isPrioritySpeakerActive: boolean; selfIsPriority: boolean; targetIsPriority: boolean }): number {
  const duck = opts.isPrioritySpeakerActive && !opts.targetIsPriority && !opts.selfIsPriority ? DUCK_FACTOR : 1;
  return Math.max(0, Math.min(2, base * duck));
}

/** Per-user listening volume is 0..2 (0-200%); NaN/garbage falls back to 100%. */
export function clampUserVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
}

/** How long the others stay ducked after the priority speaker stops, so short pauses do not make the room volume pump. */
export const DUCK_RELEASE_MS = 600;

/**
 * Whether `identity` is a priority speaker. `authoritative` (the app's list from the server's voice states) wins when given:
 * the LiveKit attribute `jv.priority` can be set by any client that holds the `canUpdateOwnMetadata` grant, so it is only
 * advisory for apps that do not have the server's list. Servers that set the attribute themselves (Jorcord does) match both.
 */
export function isPriorityIdentity(identity: string, attribute: string | undefined, authoritative: ReadonlySet<string> | null): boolean {
  return authoritative ? authoritative.has(identity) : attribute === '1';
}

/** Ducking with a release hangover: engaged while a priority speaker talks, and for DUCK_RELEASE_MS after the last moment they did. */
export class DuckGate {
  private until = 0;
  constructor(private releaseMs = DUCK_RELEASE_MS) {}
  /** `active` = some priority speaker is talking right now. Returns whether the others should be ducked. */
  update(now: number, active: boolean): boolean {
    if (active) this.until = now + this.releaseMs;
    return now < this.until;
  }
  reset() { this.until = 0; }
}
