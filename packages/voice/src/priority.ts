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
