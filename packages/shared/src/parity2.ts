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
