/** Parity pass 3: boost levels, linked roles, app directory, moderation tools (additive types shared by server and clients). */
import type { Id, User } from './types';

// ---------- server boosts ----------
/** Boosts needed for each level (index = level). Boosting is free and unlimited per member. */
export const BOOST_THRESHOLDS = [0, 2, 7, 14] as const;
export const boostLevelFor = (boosts: number): 0 | 1 | 2 | 3 => (boosts >= 14 ? 3 : boosts >= 7 ? 2 : boosts >= 2 ? 1 : 0);
export interface BoostLevelPerks {
  level: 0 | 1 | 2 | 3; boosts: number; emojiSlots: number; stickerSlots: number;
  /** Informational: Jorcord does not gate these, every server has them at every level. */ uploadMb: number; voiceKbps: number; stageKbps: number; banner: boolean; animatedIcon: boolean; vanity: boolean;
}
/** `emojiSlots` and `stickerSlots` are enforced by the server; the rest is unlocked for every server (Jorcord has no paywalled perks) and listed for parity. */
export const BOOST_LEVELS: BoostLevelPerks[] = [
  { level: 0, boosts: 0, emojiSlots: 50, stickerSlots: 5, uploadMb: 500, voiceKbps: 510, stageKbps: 510, banner: true, animatedIcon: true, vanity: true },
  { level: 1, boosts: 2, emojiSlots: 100, stickerSlots: 15, uploadMb: 500, voiceKbps: 510, stageKbps: 510, banner: true, animatedIcon: true, vanity: true },
  { level: 2, boosts: 7, emojiSlots: 150, stickerSlots: 30, uploadMb: 500, voiceKbps: 510, stageKbps: 510, banner: true, animatedIcon: true, vanity: true },
  { level: 3, boosts: 14, emojiSlots: 250, stickerSlots: 60, uploadMb: 500, voiceKbps: 510, stageKbps: 510, banner: true, animatedIcon: true, vanity: true },
];
export const boostPerks = (level: number): BoostLevelPerks => BOOST_LEVELS[Math.min(3, Math.max(0, level))]!;
export interface Booster { user: User; boosts: number; since: string }
export interface BoostSummary {
  guildId: Id; count: number; level: 0 | 1 | 2 | 3; perks: BoostLevelPerks; nextLevel: BoostLevelPerks | null; boostsToNext: number | null; myBoosts: number;
  boosters: Booster[]; settings: { announce: boolean; boosterRole: boolean; boosterRoleId: Id | null };
}

// ---------- linked roles ----------
export const LINKED_ROLE_LIMITS = { perGuild: 10, criteria: 5, maxDays: 3650, maxCount: 1_000_000, metadataKeys: 5, metadataMax: 1_000_000_000 } as const;
export type LinkedOp = '>=' | '<=' | '=' | '!=';
/** All criteria of a linked role must hold (AND). The server grants the role when they do and takes it away when they stop holding. */
export type LinkedCriterion =
  | { type: 'account_age_days'; value: number }
  | { type: 'join_age_days'; value: number }
  | { type: 'message_count'; value: number }
  /** has a verified profile connection, optionally of one provider (see CONNECTION_PROVIDERS) */
  | { type: 'connection'; provider?: string }
  /** a value an installed app's bot set for the member (PUT /applications/@me/users/:userId/role-metadata) */
  | { type: 'app_metadata'; appId: Id; key: string; op: LinkedOp; value: number | boolean };
export interface LinkedRole { id: Id; guildId: Id; roleId: Id; description: string | null; criteria: LinkedCriterion[]; createdAt: string }
export interface LinkedCriterionProgress { met: boolean; /** what the member has now (days, messages, ...) or null when unknown */ current: number | boolean | null }
export interface LinkedRoleView extends LinkedRole {
  role: { name: string; color: number } | null; holders: number;
  /** the caller's standing: one entry per criterion, and whether they hold the role now */
  progress: LinkedCriterionProgress[]; granted: boolean;
}
export type RoleMetadataType = 'integer' | 'boolean';
export interface RoleMetadataField { key: string; name: string; description?: string | null; type: RoleMetadataType }
export interface RoleMetadataApp { appId: Id; name: string; icon: string | null; fields: RoleMetadataField[] }

// ---------- app directory ----------
export const DIRECTORY_CATEGORIES = [
  { id: 'moderation', name: 'Moderation' }, { id: 'music', name: 'Music' }, { id: 'games', name: 'Games' }, { id: 'utility', name: 'Utility' },
  { id: 'fun', name: 'Fun' }, { id: 'social', name: 'Social' }, { id: 'productivity', name: 'Productivity' }, { id: 'community', name: 'Community' }, { id: 'other', name: 'Other' },
] as const;
export type DirectoryCategory = (typeof DIRECTORY_CATEGORIES)[number]['id'];
export const DIRECTORY_CATEGORY_IDS = DIRECTORY_CATEGORIES.map((c) => c.id) as [DirectoryCategory, ...DirectoryCategory[]];
export const DIRECTORY_TAG_RE = /^[a-z0-9][a-z0-9-]{1,19}$/;
export interface DirectoryApp {
  id: Id; name: string; summary: string; description: string; icon: string | null; botUserId: Id; category: DirectoryCategory; tags: string[];
  /** servers the bot is in */ installs: number; /** permission bits the app suggests when installing */ permissions: string; listedAt: string;
}

// ---------- moderation tools ----------
export type SafetyFlag = 'new_account' | 'raid_joined' | 'spam_suspect' | 'dm_restricted';
export const SAFETY_FLAGS: { id: SafetyFlag; label: string; hint: string }[] = [
  { id: 'new_account', label: 'New account', hint: 'Account is less than 7 days old' },
  { id: 'raid_joined', label: 'Raid joined', hint: 'Joined during a detected raid' },
  { id: 'spam_suspect', label: 'Spam suspect', hint: 'Tripped AutoMod 3 or more times in the last 24 hours' },
  { id: 'dm_restricted', label: 'DMs restricted', hint: 'Does not accept direct messages from server members' },
];
export const MOD_LIMITS = { noteLength: 1000, notesPerMember: 25, warningLength: 500, bulkIds: 200, bulkMax: 200, pruneMaxDays: 30, pruneBatch: 1000, filterMinutesMax: 10080 } as const;
export interface ModWarning { id: Id; guildId: Id; userId: Id; moderatorId: Id | null; reason: string; source: 'manual' | 'automod'; ruleId: Id | null; createdAt: string }
export interface ModNote { id: Id; guildId: Id; userId: Id; authorId: Id | null; note: string; createdAt: string }
export interface ModHistoryEntry { action: string; moderatorId: Id | null; reason: string | null; createdAt: string }
export interface ModView {
  user: User; isMember: boolean; joinedAt: string | null; accountCreatedAt: string; roles: Id[]; timeoutUntil: string | null; banned: boolean;
  flags: SafetyFlag[];
  counts: { timeouts: number; bans: number; kicks: number; warnings: number; automodHits24h: number };
  history: ModHistoryEntry[]; warnings: ModWarning[]; notes: ModNote[];
  mutualGuilds: { id: Id; name: string }[]; messages7d: number;
}
export interface BulkModerationFilter { joinedWithinMinutes?: number; noRoles?: boolean; accountYoungerThanDays?: number; raidFlagged?: boolean }
export interface BulkModerationResult { dryRun: boolean; action: 'ban' | 'kick'; matched: number; affected: number; skipped: { userId: Id; reason: string }[]; users: { id: Id; username: string }[] }
export interface PruneResult { dryRun: boolean; days: number; count: number; removed: number; remaining: number }
