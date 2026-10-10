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

// ---------- server onboarding ----------
/** One answer to an onboarding question: picking it grants roles and opts the member into channels. */
export interface OnboardingOption { id: Id; title: string; description: string | null; emoji: string | null; channelIds: Id[]; roleIds: Id[] }
export interface OnboardingPrompt { id: Id; title: string; singleSelect: boolean; required: boolean; options: OnboardingOption[] }
export interface OnboardingResponse { optionIds: Id[]; /** channels opted into through the chosen options */ channelIds: Id[]; completedAt: string }
export interface Onboarding {
  enabled: boolean;
  /** channels every member sees from the start */ defaultChannelIds: Id[];
  prompts: OnboardingPrompt[];
  /** my answers (null until I completed it); only on GET */ responses?: OnboardingResponse | null;
}
export const ONBOARDING_LIMITS = { prompts: 5, optionsPerPrompt: 12 } as const;

// ---------- announcement channels: follow + crosspost ----------
/** Set on a message that was published from an announcement channel into a following channel. */
export interface CrosspostOrigin { guildId: Id; guildName: string; channelId: Id; channelName: string; messageId: Id }
/** Someone (a channel elsewhere) follows an announcement channel. `target` is filled for the source side, `source` for the target side. */
export interface ChannelFollow {
  id: Id; sourceChannelId: Id; targetChannelId: Id; targetGuildId: Id; createdAt: string;
  source?: { channelName: string; guildId: Id; guildName: string; guildIcon: string | null };
  target?: { channelName: string; guildId: Id; guildName: string };
}
export const MAX_FOLLOWERS_PER_CHANNEL = 25;

// ---------- server templates, widget, insights ----------
export interface TemplateRole { key: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: string; position: number }
export interface TemplateChannel {
  key: string; type: 'text' | 'voice' | 'announcement' | 'stage' | 'forum' | 'category'; name: string; topic: string | null; nsfw: boolean; slowmode: number;
  bitrate: number | null; userLimit: number | null; position: number; parentKey: string | null;
  /** role overwrites only (`target` = 'everyone' or a role key) */ overwrites: { target: string; allow: string; deny: string }[];
}
/** What a template carries: roles, channels (+ role overwrites) and a few settings. Never messages, members, emoji or webhooks. */
export interface SerializedTemplate {
  v: 1;
  settings: { verificationLevel: number; explicitFilter: number; defaultNotifications: 'all' | 'mentions'; everyonePermissions: string };
  roles: TemplateRole[]; channels: TemplateChannel[];
}
export interface GuildTemplate {
  code: Id; guildId: Id; name: string; description: string | null; creatorId: Id; usageCount: number; createdAt: string; updatedAt: string;
  /** the server changed since the template was last synced (managers only) */ isDirty?: boolean;
  sourceGuild?: { id: Id; name: string; icon: string | null };
  /** names only, for the preview screen */ preview?: { roles: { name: string; color: number }[]; channels: { name: string; type: string; parent: string | null }[] };
}
export interface GuildWidgetSettings { enabled: boolean; channelId: Id | null; instantInvite: string | null }
/** Public `GET /guilds/:id/widget.json` */
export interface GuildWidget {
  id: Id; name: string; instantInvite: string | null; presenceCount: number;
  channels: { id: Id; name: string; position: number }[];
  members: { id: string; username: string; avatarUrl: string | null; status: 'online' | 'idle' | 'dnd'; activity?: string }[];
}
export interface GuildInsights {
  days: number; memberCount: number; onlineNow: number;
  joins: { day: string; joins: number; leaves: number }[]; messages: { day: string; count: number }[];
  totals: { joins: number; leaves: number; messages: number; activeChatters: number };
  topChannels: { channelId: Id; name: string; count: number }[];
}
export const MAX_TEMPLATE_CHANNELS = 200;

// ---------- GIF favorites / saved media ----------
export interface GifFavorite { id: Id; url: string; preview: string | null; title: string | null; width: number | null; height: number | null; createdAt: string }
export const MAX_GIF_FAVORITES = 250;
