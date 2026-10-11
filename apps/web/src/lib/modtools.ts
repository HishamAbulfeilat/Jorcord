/** Moderation tools helpers (pure, unit tested). The server enforces permissions, hierarchy and limits. */
import { MOD_LIMITS, SAFETY_FLAGS, type BulkModerationFilter, type SafetyFlag } from '@jorcord/shared';

export const flagInfo = (f: SafetyFlag) => SAFETY_FLAGS.find((x) => x.id === f) ?? { id: f, label: f, hint: '' };

/** `/warn <@id> reason`, or `/warn @username reason` when `resolve` maps a typed name to an id. null = not a /warn command. */
export function parseWarnCommand(content: string, resolve?: (name: string) => string | undefined): { userId: string; reason: string } | { error: string } | null {
  const m = /^\/warn(?:\s+([\s\S]*))?$/.exec(content.trim()); if (!m) return null;
  const rest = (m[1] ?? '').trim();
  let t: RegExpExecArray | string[] | null = /^<@!?(\d{1,20})>\s*([\s\S]*)$/.exec(rest);
  if (!t) { const n = /^@(\S{1,64})\s*([\s\S]*)$/.exec(rest); const id = n && resolve?.(n[1]!); if (n && id) t = ['', id, n[2]!]; else if (n && resolve) return { error: `No member named ${n[1]}` }; }
  if (!t) return { error: 'Usage: /warn @member reason' };
  const reason = t[2]!.trim();
  if (!reason) return { error: 'Add a reason: /warn @member reason' };
  if (reason.length > MOD_LIMITS.warningLength) return { error: `Reason is too long (${reason.length}/${MOD_LIMITS.warningLength})` };
  return { userId: t[1]!, reason };
}

/** User ids separated by spaces, commas or lines; `<@id>` mentions are accepted. Duplicates are dropped. */
export function parseIdList(text: string): { ids: string[]; invalid: string[]; tooMany: boolean } {
  const ids: string[] = [], invalid: string[] = [], seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    const id = /^<@!?(\d{1,20})>$/.exec(raw)?.[1] ?? (/^\d{1,20}$/.test(raw) ? raw : null);
    if (!id) { invalid.push(raw); continue; }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return { ids, invalid, tooMany: ids.length > MOD_LIMITS.bulkIds };
}

export interface BulkForm { ids: string; joinedMinutes: string; noRoles: boolean; youngDays: string; raidFlagged: boolean }
export const blankBulk: BulkForm = { ids: '', joinedMinutes: '', noRoles: false, youngDays: '', raidFlagged: false };
const posInt = (s: string, max: number) => (/^\d+$/.test(s.trim()) && Number(s) >= 1 ? Math.min(max, Number(s)) : undefined);
/** Request body parts for POST /moderation/bulk, or the reason it cannot be sent. */
export function bulkRequest(f: BulkForm): { userIds?: string[]; filter?: BulkModerationFilter } | { error: string } {
  const list = parseIdList(f.ids);
  if (list.invalid.length) return { error: `Not a user id: ${list.invalid.slice(0, 3).join(', ')}${list.invalid.length > 3 ? '…' : ''}` };
  if (list.tooMany) return { error: `At most ${MOD_LIMITS.bulkIds} ids at once` };
  const filter: BulkModerationFilter = {};
  const j = posInt(f.joinedMinutes, MOD_LIMITS.filterMinutesMax), y = posInt(f.youngDays, 365);
  if (f.joinedMinutes.trim() && j === undefined) return { error: 'Joined within: enter a number of minutes' };
  if (f.youngDays.trim() && y === undefined) return { error: 'Account age: enter a number of days' };
  if (j) filter.joinedWithinMinutes = j; if (y) filter.accountYoungerThanDays = y; if (f.noRoles) filter.noRoles = true; if (f.raidFlagged) filter.raidFlagged = true;
  if (!list.ids.length && !Object.keys(filter).length) return { error: 'Paste user ids or choose at least one filter' };
  return { ...(list.ids.length ? { userIds: list.ids } : {}), ...(Object.keys(filter).length ? { filter } : {}) };
}

const HISTORY: Record<string, string> = { MEMBER_TIMEOUT: 'Timeout', MEMBER_BAN_ADD: 'Ban', MEMBER_BAN_REMOVE: 'Unban', MEMBER_KICK: 'Kick', MEMBER_WARN: 'Warning' };
export const historyLabel = (a: string) => HISTORY[a] ?? a;
/** "3 days", "5 hours", "just now" */
export function ageText(iso: string | null, now = Date.now()): string {
  if (!iso) return 'unknown';
  const ms = Math.max(0, now - new Date(iso).getTime()), d = Math.floor(ms / 86_400_000);
  if (d >= 365) return `${Math.floor(d / 365)} year${d >= 730 ? 's' : ''}`;
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}`;
  const h = Math.floor(ms / 3_600_000); if (h >= 1) return `${h} hour${h === 1 ? '' : 's'}`;
  const m = Math.floor(ms / 60_000); return m >= 1 ? `${m} minute${m === 1 ? '' : 's'}` : 'just now';
}
