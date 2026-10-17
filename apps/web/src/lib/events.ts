/** Scheduled-event helpers (docs/CONTRACT.md "Scheduled events"). Times are ISO strings on the wire. */
import { ScheduledEventEntityType as ET, ScheduledEventStatus as ST } from '@jorcord/shared';
import type { ScheduledEvent } from '@jorcord/shared';

export const entityLabel = (t: number) => (t === ET.STAGE_INSTANCE ? 'Stage' : t === ET.VOICE ? 'Voice Channel' : 'Somewhere Else');
export const isLive = (e: Pick<ScheduledEvent, 'status'>) => e.status === ST.ACTIVE;
export const isUpcoming = (e: Pick<ScheduledEvent, 'status'>) => e.status === ST.SCHEDULED || e.status === ST.ACTIVE;

/** Active first, then by start time. */
export function sortEvents(list: ScheduledEvent[]): ScheduledEvent[] {
  return [...list].filter(isUpcoming).sort((a, b) => (isLive(b) ? 1 : 0) - (isLive(a) ? 1 : 0) || Date.parse(a.scheduledStartTime) - Date.parse(b.scheduledStartTime));
}

/** `datetime-local` value ("2026-10-10T18:30", local time) -> ISO with offset; null when empty/invalid. */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** ISO -> `datetime-local` value in the viewer's time zone. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface EventDraft { name: string; description: string; entityType: number; channelId: string; location: string; start: string; end: string; recurrenceRule: { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; until: string } | null }
/** Validates a draft against the server rules (contract: external events need a location + end time; channel events need a channel; start in the future). */
export function validateEvent(d: EventDraft, now = Date.now()): { ok: true; body: { name: string; description: string | null; entityType: number; channelId: string | null; location: string | null; scheduledStartTime: string; scheduledEndTime: string | null; privacyLevel: 2; recurrenceRule: { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; until?: string } | null } } | { ok: false; error: string } {
  const name = d.name.trim(); const start = localInputToIso(d.start); const end = localInputToIso(d.end);
  if (!name) return { ok: false, error: 'Give your event a name' };
  if (!start) return { ok: false, error: 'Pick a start time' };
  if (Date.parse(start) <= now) return { ok: false, error: 'The start time must be in the future' };
  if (end && Date.parse(end) <= Date.parse(start)) return { ok: false, error: 'The end time must be after the start time' };
  if (d.entityType === ET.EXTERNAL) {
    if (!d.location.trim()) return { ok: false, error: 'Add a location' };
    if (!end) return { ok: false, error: 'External events need an end time' };
  } else if (!d.channelId) return { ok: false, error: 'Choose a channel' };
  let recurrenceRule: { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; until?: string } | null = null;
  if (d.recurrenceRule) {
    const r = d.recurrenceRule;
    const untilIso = localInputToIso(r.until);
    if (untilIso && Date.parse(untilIso) <= Date.parse(start)) return { ok: false, error: 'The repeat end date must be after the start time' };
    recurrenceRule = { frequency: r.frequency, interval: r.interval, ...(untilIso ? { until: untilIso } : {}) };
  }
  return { ok: true, body: { name, description: d.description.trim() || null, entityType: d.entityType, channelId: d.entityType === ET.EXTERNAL ? null : d.channelId, location: d.entityType === ET.EXTERNAL ? d.location.trim() : null, scheduledStartTime: start, scheduledEndTime: end, privacyLevel: 2, recurrenceRule } };
}

/** "Today at 6:30 PM", "Tomorrow", else a short date. `fmtTime` is injected so tests do not depend on the locale. */
export function whenText(iso: string, now = Date.now(), fmt: (d: Date) => string = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })): string {
  const d = new Date(iso); const n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(n)) / 86_400_000);
  const t = fmt(d);
  if (diff === 0) return `Today at ${t}`;
  if (diff === 1) return `Tomorrow at ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${t}`;
}

/** Applies GUILD_SCHEDULED_EVENT_USER_ADD/REMOVE. */
export function applyInterest(e: ScheduledEvent, delta: 1 | -1, mine: boolean): ScheduledEvent {
  return { ...e, userCount: Math.max(0, e.userCount + delta), interested: mine ? delta > 0 : e.interested };
}
