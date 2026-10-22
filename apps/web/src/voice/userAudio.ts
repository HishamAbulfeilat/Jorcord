import type { Prefs } from '@/stores/ui';

/** Per-listener volume for one person: 0-200 %, default 100. Stored as percent in prefs (synced with the account). */
export const USER_VOLUME_MIN = 0;
export const USER_VOLUME_MAX = 200;
/** Prefs live inside the 16 KB account-settings blob: only non-default entries are kept, and at most this many people. */
export const MAX_USER_AUDIO_ENTRIES = 200;

export const clampPercent = (v: number): number => Number.isFinite(v) ? Math.max(USER_VOLUME_MIN, Math.min(USER_VOLUME_MAX, Math.round(v))) : 100;
export const userPercent = (p: Pick<Prefs, 'userVolumes'>, userId: string): number => clampPercent(p.userVolumes[userId] ?? 100);
export const isUserMuted = (p: Pick<Prefs, 'userMuted'>, userId: string): boolean => !!p.userMuted[userId];

/** Returns the prefs patch for a new volume (100 removes the entry so the map stays small). */
export function withUserVolume(p: Pick<Prefs, 'userVolumes'>, userId: string, percent: number): Record<string, number> {
  const next = { ...p.userVolumes }; const v = clampPercent(percent);
  if (v === 100) delete next[userId]; else next[userId] = v;
  return cap(next);
}
export function withUserMuted(p: Pick<Prefs, 'userMuted'>, userId: string, muted: boolean): Record<string, boolean> {
  const next = { ...p.userMuted };
  if (muted) next[userId] = true; else delete next[userId];
  return cap(next);
}
function cap<T>(m: Record<string, T>): Record<string, T> {
  const keys = Object.keys(m); if (keys.length <= MAX_USER_AUDIO_ENTRIES) return m;
  return Object.fromEntries(keys.slice(keys.length - MAX_USER_AUDIO_ENTRIES).map((k) => [k, m[k]!]));
}

/** Prefs -> the client's units (volume 0..2). */
export function audioMapsForClient(p: Pick<Prefs, 'userVolumes' | 'userMuted'>): { volumes: Record<string, number>; muted: Record<string, boolean> } {
  return { volumes: Object.fromEntries(Object.entries(p.userVolumes).map(([k, v]) => [k, clampPercent(v) / 100])), muted: p.userMuted };
}
