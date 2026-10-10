import type { Activity, ActivityType } from '@jorcord/shared';

export const ACTIVITY_TYPES: { id: ActivityType; label: string }[] = [
  { id: 'playing', label: 'Playing' }, { id: 'listening', label: 'Listening to' }, { id: 'watching', label: 'Watching' }, { id: 'streaming', label: 'Streaming' }, { id: 'competing', label: 'Competing in' },
];
/** "Playing Chess", "Listening to Lo-fi", ... */
export function activityLabel(a: Pick<Activity, 'type' | 'name'>): string {
  const verb = ACTIVITY_TYPES.find((x) => x.id === a.type)?.label ?? 'Playing';
  return `${verb} ${a.name}`;
}
/** The activity worth a one-liner: streaming first, then the first in the list. */
export function primaryActivity(list: Activity[] | undefined): Activity | undefined {
  return list?.find((a) => a.type === 'streaming') ?? list?.[0];
}
/** "for 12 minutes" style elapsed text. */
export function activityElapsed(startedAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24); return `${d} day${d === 1 ? '' : 's'}`;
}
