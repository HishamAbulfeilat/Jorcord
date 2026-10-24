/** Parity pass 3, package C: accounts, social and safety (additive types and catalogs shared by server and clients). */
import type { Id, User } from './types';

// ---------- username / email change ----------
export const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;
export const USERNAME_CHANGE_LIMIT = { changes: 2, windowDays: 30, reserveDays: 14 } as const;
/** Server reply to `POST /users/@me/username` (the updated own profile is `user`). */
export interface UsernameChangeResult { user: User; changesLeft: number; nextChangeAt: string | null }

// ---------- display-name styles (free, original; drawn with CSS only) ----------
export interface DisplayNameStyle { font: string; effect: string }
export const DISPLAY_NAME_FONTS = [
  { id: 'default', name: 'Default' }, { id: 'serif', name: 'Serif' }, { id: 'mono', name: 'Monospace' }, { id: 'rounded', name: 'Rounded' },
  { id: 'display', name: 'Display' }, { id: 'hand', name: 'Handwritten' }, { id: 'slab', name: 'Slab' }, { id: 'condensed', name: 'Condensed' },
] as const;
export const DISPLAY_NAME_EFFECTS = [
  { id: 'none', name: 'None' }, { id: 'solid', name: 'Solid' }, { id: 'gradient-sunset', name: 'Sunset gradient' }, { id: 'gradient-ocean', name: 'Ocean gradient' },
  { id: 'neon', name: 'Neon' }, { id: 'glow', name: 'Soft glow' }, { id: 'shimmer', name: 'Shimmer' }, { id: 'toon', name: 'Outline' },
] as const;
export const DISPLAY_NAME_FONT_IDS = DISPLAY_NAME_FONTS.map((f) => f.id) as unknown as readonly [string, ...string[]];
export const DISPLAY_NAME_EFFECT_IDS = DISPLAY_NAME_EFFECTS.map((f) => f.id) as unknown as readonly [string, ...string[]];

// ---------- disappearing messages ----------
/** Allowed `messageTtlSeconds` values: 0 = off, 1 hour, 1 day, 1 week. */
export const MESSAGE_TTL_OPTIONS = [0, 3600, 86_400, 604_800] as const;
export const messageTtlLabel = (s: number): string => (s >= 604_800 ? '1 week' : s >= 86_400 ? '1 day' : s >= 3600 ? '1 hour' : 'Off');

// ---------- safety alerts ----------
export interface SafetyAlerts { channelId: Id | null; raid: boolean; massDm: boolean }
export const DEFAULT_SAFETY_ALERTS: SafetyAlerts = { channelId: null, raid: true, massDm: true };
/** customId prefix of the buttons on an alert message; the server answers these itself. */
export const SAFETY_ALERT_PREFIX = 'jc:safety:';
export type SafetyAlertAction = 'lock' | 'kick' | 'dismiss';

// ---------- ignore ----------
/** `GET /users/@me/ignored` */
export interface IgnoredList { users: User[] }

// ---------- welcome wave ----------
/** Standard sticker sent as a reply by the "Wave to say hi" action on a join message. */
export const WAVE_STICKER_ID = 'std_hi';

// ---------- inbox ----------
export type ThreadNotifyLevel = 'all' | 'mentions' | 'none';
export interface InboxUnreadChannel { channelId: Id; guildId: Id | null; name: string | null; mentionCount: number; lastMessageId: Id; lastReadId: Id | null }
export interface InboxThread { threadId: Id; parentId: Id | null; guildId: Id | null; name: string | null; lastMessageId: Id | null; lastReadId: Id | null; mentionCount: number; unread: boolean; level: ThreadNotifyLevel }
