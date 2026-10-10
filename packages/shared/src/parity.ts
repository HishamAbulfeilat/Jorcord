/** Parity pass: soundboard, activities, cosmetics, safety, onboarding... (additive types shared by server and clients). */
import type { Id } from './types';

// ---------- soundboard ----------
export interface SoundboardSound { id: Id; guildId: Id; name: string; emoji: string | null; /** 0..1 playback gain */ volume: number; url: string; creatorId: Id; createdAt: string }

// ---------- rich presence / activities ----------
export type ActivityType = 'playing' | 'streaming' | 'listening' | 'watching' | 'competing';
/** What someone is doing right now. Set by the user's own client, or by a bot for itself; shown in the member list, friends list and profile. */
export interface Activity {
  type: ActivityType; name: string; details?: string | null; state?: string | null;
  /** streaming: link to the stream (http/https) */ url?: string | null;
  /** ISO time the activity began (the server fills it in when omitted) */ startedAt: string;
  applicationId?: Id | null; largeImage?: string | null; smallImage?: string | null;
}
export const MAX_ACTIVITIES = 5;

// ---------- cosmetics: avatar decorations, profile effects, name plates, server tags ----------
/** Free, original catalog: every item is drawn with CSS/SVG by the clients (no image assets). Servers validate ids against these lists. */
export interface CosmeticItem { id: string; name: string }
export const AVATAR_DECORATIONS: CosmeticItem[] = [
  { id: 'aurora', name: 'Aurora Ring' }, { id: 'sunset', name: 'Sunset Ring' }, { id: 'neon', name: 'Neon Pulse' }, { id: 'frost', name: 'Frostbite' },
  { id: 'ember', name: 'Ember Glow' }, { id: 'wreath', name: 'Leaf Wreath' }, { id: 'halo', name: 'Star Halo' }, { id: 'pixel', name: 'Pixel Frame' },
];
export const PROFILE_EFFECTS: CosmeticItem[] = [
  { id: 'sparkles', name: 'Sparkles' }, { id: 'snowfall', name: 'Snowfall' }, { id: 'confetti', name: 'Confetti' },
  { id: 'rain', name: 'Rainfall' }, { id: 'fireflies', name: 'Fireflies' }, { id: 'bubbles', name: 'Bubbles' },
];
export const NAME_PLATES: CosmeticItem[] = [
  { id: 'sunrise', name: 'Sunrise' }, { id: 'ocean', name: 'Ocean' }, { id: 'forest', name: 'Forest' },
  { id: 'nebula', name: 'Nebula' }, { id: 'gold', name: 'Gold Leaf' }, { id: 'mono', name: 'Mono' },
];
/** Icons a server can put on its tag badge (clients map these ids to glyphs). */
export const TAG_BADGES: CosmeticItem[] = [
  { id: 'sword', name: 'Sword' }, { id: 'leaf', name: 'Leaf' }, { id: 'star', name: 'Star' }, { id: 'flame', name: 'Flame' }, { id: 'bolt', name: 'Bolt' }, { id: 'heart', name: 'Heart' },
  { id: 'skull', name: 'Skull' }, { id: 'crown', name: 'Crown' }, { id: 'gem', name: 'Gem' }, { id: 'moon', name: 'Moon' }, { id: 'sun', name: 'Sun' }, { id: 'paw', name: 'Paw' },
];
const ids = (l: CosmeticItem[]) => l.map((i) => i.id) as [string, ...string[]];
export const AVATAR_DECORATION_IDS = ids(AVATAR_DECORATIONS), PROFILE_EFFECT_IDS = ids(PROFILE_EFFECTS), NAME_PLATE_IDS = ids(NAME_PLATES), TAG_BADGE_IDS = ids(TAG_BADGES);
/** The server tag a user chose to wear: shown beside their name everywhere. */
export interface ServerTag { guildId: Id; tag: string; badge: string | null }
export const SERVER_TAG_RE = /^[A-Za-z0-9]{3,4}$/;

// ---------- safety ----------
/** 0 none, 1 verified email, 2 + account older than 5 minutes, 3 + member for 10 minutes, 4 + verified email and account older than 7 days (Jorcord has no phone numbers, so "highest" uses account age instead). Members with a role are exempt. */
export type VerificationLevel = 0 | 1 | 2 | 3 | 4;
/** 0 off, 1 blur media from members without roles, 2 blur media from everyone. Without an image classifier the media is delivered as a spoiler (blurred until clicked) and only in channels that are not age-restricted. */
export type ExplicitFilter = 0 | 1 | 2;
export interface RaidProtection { enabled: boolean; /** joins that trip the alarm */ maxJoins: number; /** within this many seconds */ windowSeconds: number; /** invites stay paused this long */ lockMinutes: number }
export const DEFAULT_RAID_PROTECTION: RaidProtection = { enabled: false, maxJoins: 10, windowSeconds: 60, lockMinutes: 60 };
export interface GuildSafety {
  verificationLevel: VerificationLevel; explicitFilter: ExplicitFilter; defaultNotifications: 'all' | 'mentions';
  raidProtection: RaidProtection; invitesPausedUntil: string | null;
  /** Safety Setup checklist: what is already done. */
  checklist: { id: string; done: boolean }[]; score: number;
}
export type SafetyPreset = 'basic' | 'recommended' | 'strict';
