/**
 * Moderation suite (package F): pure helpers shared by the server and the web app. See docs/MODERATION.md.
 * Nothing here touches the network, a clock (callers pass `now`) or a database.
 */
import { Perm, type PermName } from './permissions';
import { levenshtein, skeleton } from './trust';

type Id = string;

// ---------- per-server settings (guilds.mod_settings) ----------
export interface ModSettings {
  /** Remember a member's roles when they leave the server so a rejoin can restore them (never escalates, see {@link restorableRoles}). */
  rememberRoles: { enabled: boolean; onKick: boolean; onLeave: boolean; days: number };
  /** Tell a member why they were kicked / banned / timed out. The moderator is named only with `showModerator`. */
  notices: { enabled: boolean; showModerator: boolean; appealLink: boolean };
  /** Flag new members who resemble recently banned ones (name, avatar, timing, invite). */
  evasion: { enabled: boolean };
  /** null = keep forever. */
  retention: { auditDays: number | null; editDays: number | null };
  /** Server default for blurring media in the report queue (each moderator can override). */
  wellbeing: { blurMedia: boolean };
}
export const MOD_SETTINGS_LIMITS = { rememberDays: [1, 30], auditDays: [30, 730], editDays: [1, 365] } as const;
export const DEFAULT_MOD_SETTINGS: ModSettings = {
  rememberRoles: { enabled: true, onKick: true, onLeave: false, days: 7 },
  notices: { enabled: true, showModerator: false, appealLink: true },
  evasion: { enabled: false },
  retention: { auditDays: null, editDays: null },
  wellbeing: { blurMedia: true },
};
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const clampInt = (v: unknown, [lo, hi]: readonly [number, number] | readonly number[], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi!, Math.max(lo!, Math.round(v))) : d);
const days = (v: unknown, range: readonly number[]): number | null => (v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? clampInt(v, range, range[0]!) : null);

/** Fills in defaults and clamps everything: the stored JSON is never trusted. */
export function normalizeModSettings(raw: unknown): ModSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_MOD_SETTINGS;
  return {
    rememberRoles: {
      enabled: bool(r.rememberRoles?.enabled, d.rememberRoles.enabled), onKick: bool(r.rememberRoles?.onKick, d.rememberRoles.onKick), onLeave: bool(r.rememberRoles?.onLeave, d.rememberRoles.onLeave),
      days: clampInt(r.rememberRoles?.days, MOD_SETTINGS_LIMITS.rememberDays, d.rememberRoles.days),
    },
    notices: { enabled: bool(r.notices?.enabled, d.notices.enabled), showModerator: bool(r.notices?.showModerator, d.notices.showModerator), appealLink: bool(r.notices?.appealLink, d.notices.appealLink) },
    evasion: { enabled: bool(r.evasion?.enabled, d.evasion.enabled) },
    retention: { auditDays: days(r.retention?.auditDays, MOD_SETTINGS_LIMITS.auditDays), editDays: days(r.retention?.editDays, MOD_SETTINGS_LIMITS.editDays) },
    wellbeing: { blurMedia: bool(r.wellbeing?.blurMedia, d.wellbeing.blurMedia) },
  };
}

// ---------- audit diffs ----------
/** Exactly the fields an audited action changed. `before` is empty for creations, `after` for deletions. */
export interface AuditDiff { before: Record<string, unknown>; after: Record<string, unknown> }
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Changed fields between two plain objects (only `keys` when given). Null when nothing differs. */
export function diffFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined, keys?: readonly string[]): AuditDiff | null {
  const b = before ?? {}, a = after ?? {};
  const out: AuditDiff = { before: {}, after: {} };
  for (const k of keys ?? [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
    if (same(b[k], a[k])) continue;
    if (k in b) out.before[k] = b[k] ?? null;
    if (k in a) out.after[k] = a[k] ?? null;
  }
  return Object.keys(out.before).length || Object.keys(out.after).length ? out : null;
}
/** Permission names held in a bitfield (string or bigint), for human diffs. */
export function permNamesOf(bits: string | bigint | number): PermName[] {
  let v: bigint; try { v = BigInt(bits); } catch { return []; }
  return (Object.keys(Perm) as PermName[]).filter((k) => (v & Perm[k]) === Perm[k]);
}
/** Added / removed permission names between two bitfields. */
export function permissionDelta(before: string | bigint, after: string | bigint): { added: PermName[]; removed: PermName[] } {
  const b = new Set(permNamesOf(before)), a = new Set(permNamesOf(after));
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}
export interface AuditQuery { actorId?: Id; action?: string; actionType?: number; targetId?: Id; from?: string; to?: string; q?: string; before?: Id; limit?: number }

// ---------- remembered roles ----------
/** Permissions that make a role privileged: not handed back automatically unless a moderator who could grant it removed the member. */
export const PRIVILEGED_BITS = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD | Perm.MANAGE_ROLES | Perm.MANAGE_CHANNELS | Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS
  | Perm.MANAGE_MESSAGES | Perm.MANAGE_WEBHOOKS | Perm.MANAGE_THREADS | Perm.MENTION_EVERYONE | Perm.VIEW_AUDIT_LOG | Perm.MANAGE_EMOJIS | Perm.MANAGE_EVENTS | Perm.MANAGE_NICKNAMES;
export interface RememberedRole { id: Id; permissions: string }
export interface CurrentRole { id: Id; position: number; permissions: string; managed: boolean }
/** The moderator whose reach limits a restore (null = the member left on their own, or the moderator is gone). */
export interface Grantor { isOwner: boolean; administrator: boolean; topPosition: number; perms: bigint }
export type SkipReason = 'gone' | 'managed' | 'escalated' | 'above_moderator' | 'beyond_moderator' | 'privileged';

/**
 * Which remembered roles may come back. Never more than the member had: a role that no longer exists, is managed by the server, gained
 * permissions since it was remembered, or (when a moderator removed the member) outranks that moderator or carries permissions they lack is skipped.
 * With no moderator to vouch for it, privileged roles stay off and must be given back by hand.
 */
export function restorableRoles(guildId: Id, remembered: RememberedRole[], current: Map<Id, CurrentRole>, grantor: Grantor | null): { restore: Id[]; skipped: { id: Id; why: SkipReason }[] } {
  const restore: Id[] = [], skipped: { id: Id; why: SkipReason }[] = [];
  for (const rr of remembered) {
    if (rr.id === guildId) continue;
    const cur = current.get(rr.id);
    if (!cur) { skipped.push({ id: rr.id, why: 'gone' }); continue; }
    if (cur.managed) { skipped.push({ id: rr.id, why: 'managed' }); continue; }
    let was: bigint, now: bigint;
    try { was = BigInt(rr.permissions); now = BigInt(cur.permissions); } catch { skipped.push({ id: rr.id, why: 'escalated' }); continue; }
    if ((now & ~was) !== 0n) { skipped.push({ id: rr.id, why: 'escalated' }); continue; }
    if (grantor) {
      if (!grantor.isOwner && !grantor.administrator) {
        if (grantor.topPosition <= cur.position) { skipped.push({ id: rr.id, why: 'above_moderator' }); continue; }
        if ((now & ~grantor.perms) !== 0n) { skipped.push({ id: rr.id, why: 'beyond_moderator' }); continue; }
      }
    } else if ((now & PRIVILEGED_BITS) !== 0n) { skipped.push({ id: rr.id, why: 'privileged' }); continue; }
    restore.push(rr.id);
  }
  return { restore, skipped };
}

// ---------- ban-evasion hints ----------
export type EvasionSignalKind = 'name' | 'avatar' | 'timing' | 'invite';
export interface EvasionSignal { kind: EvasionSignalKind; weight: number; detail: string }
export const EVASION_MIN_SCORE = 45;
export const EVASION_WINDOW_DAYS = 90;
export const EVASION_TIMING_DAYS = 14;
export interface EvasionSubject { username: string; displayName?: string | null; avatar?: string | null; createdAt: string | number | Date; joinedVia?: string | null }
export interface EvasionBanned extends Omit<EvasionSubject, 'createdAt'> { bannedAt: string | number | Date }

const nameClose = (a: string, b: string): 'same' | 'close' | null => {
  if (a.length < 4 || b.length < 4) return null;
  const sa = skeleton(a), sb = skeleton(b);
  if (sa.length < 4 || sb.length < 4) return null;
  if (sa === sb) return 'same';
  const max = Math.min(sa.length, sb.length) >= 10 ? 2 : Math.min(sa.length, sb.length) >= 5 ? 1 : 0;
  return max > 0 && levenshtein(sa, sb, max) <= max ? 'close' : null;
};
/**
 * Compares a new member with one banned user using only what the account itself shows: name and display name (look-alike folding, small edit
 * distance), the same avatar, an account created shortly after the ban, and the same invite code. No IP address and no device fingerprint
 * are involved. Any single weak signal stays under {@link EVASION_MIN_SCORE}.
 */
export function evasionSignals(subject: EvasionSubject, banned: EvasionBanned): EvasionSignal[] {
  const out: EvasionSignal[] = [];
  let best: 'same' | 'close' | null = null;
  for (const a of [subject.username, subject.displayName]) for (const b of [banned.username, banned.displayName]) {
    if (!a || !b) continue;
    const m = nameClose(a, b);
    if (m === 'same' || (m === 'close' && best === null)) best = m;
  }
  if (best === 'same') out.push({ kind: 'name', weight: 45, detail: 'Name matches a banned account (ignoring look-alike letters)' });
  else if (best === 'close') out.push({ kind: 'name', weight: 35, detail: 'Name is very close to a banned account' });
  if (subject.avatar && banned.avatar && subject.avatar === banned.avatar) out.push({ kind: 'avatar', weight: 30, detail: 'Same avatar as a banned account' });
  const created = new Date(subject.createdAt).getTime(), bannedAt = new Date(banned.bannedAt).getTime();
  if (Number.isFinite(created) && Number.isFinite(bannedAt) && created >= bannedAt && created - bannedAt <= EVASION_TIMING_DAYS * 86_400_000)
    out.push({ kind: 'timing', weight: 20, detail: `Account created ${Math.max(0, Math.round((created - bannedAt) / 86_400_000))} day(s) after that ban` });
  if (subject.joinedVia && banned.joinedVia && subject.joinedVia === banned.joinedVia) out.push({ kind: 'invite', weight: 15, detail: 'Joined with the same invite code' });
  return out;
}
export const evasionScore = (signals: EvasionSignal[]) => Math.min(100, signals.reduce((a, s) => a + s.weight, 0));

// ---------- reports ----------
/** Canned actions a moderator can attach when resolving a report. */
export const REPORT_ACTIONS = ['none', 'delete_message', 'mark_sensitive', 'warn', 'timeout'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];
export const REPORT_TIMEOUT_MINUTES = 60;
/** Reporter throttling: many dismissed reports and nothing upheld recently -> only a few reports per day. */
export const REPORT_ABUSE = { windowDays: 14, minDismissed: 5, dismissedShare: 0.8, throttledPerDay: 2 } as const;
export function reporterThrottled(stats: { dismissed: number; resolved: number }): boolean {
  const total = stats.dismissed + stats.resolved;
  return stats.dismissed >= REPORT_ABUSE.minDismissed && stats.dismissed / Math.max(1, total) >= REPORT_ABUSE.dismissedShare;
}

// ---------- moderator wellbeing ----------
export interface QuietHours { start: number | null; end: number | null; tzOffset: number }
/** Is `now` inside the moderator's quiet window? Minutes after local midnight; the window may wrap midnight; start == end means off. */
export function inQuietHours(q: QuietHours | null | undefined, now: number = Date.now()): boolean {
  if (!q || q.start == null || q.end == null || q.start === q.end) return false;
  const local = (((Math.floor(now / 60_000) + (q.tzOffset || 0)) % 1440) + 1440) % 1440;
  return q.start < q.end ? local >= q.start && local < q.end : local >= q.start || local < q.end;
}

// ---------- wire types ----------
export interface ModPrefs { blurMedia: boolean | null; quietStart: number | null; quietEnd: number | null; tzOffset: number }
export interface ModNotice { id: Id; guildId: Id; guildName: string; kind: 'kick' | 'ban' | 'timeout'; reason: string | null; moderatorId: Id | null; appeal: boolean; until: string | null; createdAt: string; readAt: string | null }
export interface EvasionHint {
  id: Id; guildId: Id; userId: Id; bannedUserId: Id; score: number; signals: EvasionSignal[]; status: 'open' | 'dismissed' | 'confirmed'; createdAt: string; handledBy?: Id | null; handledAt?: string | null;
}
