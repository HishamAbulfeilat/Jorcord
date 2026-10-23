/** Helpers for composing a message to send later (see components/modals/ScheduleModal.tsx). */
import { SCHEDULED_MESSAGE_LIMITS } from '@jorcord/shared';

const pad = (n: number) => String(n).padStart(2, '0');
/** `<input type="datetime-local">` value (local wall-clock time, minute precision). */
export function toLocalInput(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
/** Parse a datetime-local value as local time. NaN-safe: null when empty or invalid. */
export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v); if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Why a chosen time cannot be used, or null when it is fine. The server enforces the same window. */
export function scheduleProblem(at: Date | null, now = Date.now()): string | null {
  if (!at) return 'Pick a date and time';
  if (at.getTime() < now + SCHEDULED_MESSAGE_LIMITS.minDelayMs) return 'Pick a time in the future';
  if (at.getTime() > now + SCHEDULED_MESSAGE_LIMITS.maxDelayMs) return 'Pick a time within the next 30 days';
  return null;
}

/** Only the fields an edit actually changed (the server rejects an empty PATCH). `attachments` is the full list of ids to keep plus newly uploaded ones. */
export function schedulePatch(orig: { content: string; sendAt: string; attachments: { id: string }[] }, next: { content: string; sendAt: string; attachmentIds: string[] }) {
  const out: { content?: string; sendAt?: string; attachments?: string[] } = {};
  if (next.content !== orig.content) out.content = next.content;
  if (Date.parse(next.sendAt) !== Date.parse(orig.sendAt)) out.sendAt = next.sendAt;
  const a = orig.attachments.map((x) => x.id);
  if (a.length !== next.attachmentIds.length || a.some((x, i) => x !== next.attachmentIds[i])) out.attachments = next.attachmentIds;
  return out;
}

export interface Preset{ id: string; label: string; at: Date }
/** Quick choices: in an hour, this evening (18:00, only while still ahead), tomorrow 09:00, next Monday 09:00. */
export function presets(now = new Date()): Preset[] {
  const out: Preset[] = [{ id: 'hour', label: 'In 1 hour', at: new Date(now.getTime() + 3600_000) }];
  const evening = new Date(now); evening.setHours(18, 0, 0, 0);
  if (evening.getTime() > now.getTime() + 15 * 60_000) out.push({ id: 'evening', label: 'This evening', at: evening });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  out.push({ id: 'tomorrow', label: 'Tomorrow morning', at: tomorrow });
  const monday = new Date(now); monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7)); monday.setHours(9, 0, 0, 0);
  if (monday.getDate() !== tomorrow.getDate() || monday.getMonth() !== tomorrow.getMonth()) out.push({ id: 'monday', label: 'Monday morning', at: monday });
  return out;
}
