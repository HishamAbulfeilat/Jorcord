/** Boost page + announcement presentation (pure, unit tested). */
import { BOOST_LEVELS, type BoostLevelPerks, type BoostSummary } from '@jorcord/shared';

export interface PerkRow { id: string; label: string; value: string; /** true when Jorcord enforces it per level, false when every server already has it */ gated: boolean }
const mb = (n: number) => (n >= 1000 ? `${n / 1000} GB` : `${n} MB`);
/** The perks of one level, in display order. Emoji and sticker slots are the only ones that grow with the level; the rest is unlocked everywhere. */
export function perkRows(p: BoostLevelPerks): PerkRow[] {
  return [
    { id: 'emoji', label: 'Emoji slots', value: String(p.emojiSlots), gated: true },
    { id: 'sticker', label: 'Sticker slots', value: String(p.stickerSlots), gated: true },
    { id: 'upload', label: 'Upload size', value: mb(p.uploadMb), gated: false },
    { id: 'voice', label: 'Voice bitrate', value: `${p.voiceKbps} kbps`, gated: false },
    { id: 'stage', label: 'Stage bitrate', value: `${p.stageKbps} kbps`, gated: false },
    { id: 'banner', label: 'Server banner', value: p.banner ? 'Yes' : 'No', gated: false },
    { id: 'icon', label: 'Animated server icon', value: p.animatedIcon ? 'Yes' : 'No', gated: false },
    { id: 'vanity', label: 'Custom invite link', value: p.vanity ? 'Yes' : 'No', gated: false },
  ];
}
/** Perks a level adds over the previous one (what the level card highlights). */
export function levelGain(level: 1 | 2 | 3): string[] {
  const a = BOOST_LEVELS[level]!, b = BOOST_LEVELS[level - 1]!;
  return [`+${a.emojiSlots - b.emojiSlots} emoji slots (${a.emojiSlots} total)`, `+${a.stickerSlots - b.stickerSlots} sticker slots (${a.stickerSlots} total)`];
}
/** 0..100 progress toward the next level, counted from the current level's threshold. */
export function levelProgress(s: Pick<BoostSummary, 'count' | 'level' | 'nextLevel'>): number {
  if (!s.nextLevel) return 100;
  const from = BOOST_LEVELS[s.level]!.boosts, span = s.nextLevel.boosts - from;
  return Math.max(0, Math.min(100, Math.round(((s.count - from) / span) * 100)));
}
/** Text after the booster's name in the system channel: "level:2" = the boost reached that level, "x3" = several boosts at once. */
export function boostAnnouncement(content: string, serverName?: string): string {
  const lvl = /^level:([1-3])$/.exec(content), many = /^x(\d{1,2})$/.exec(content);
  if (lvl) return `just boosted ${serverName ? serverName : 'the server'}! It reached Level ${lvl[1]}!`;
  if (many) return `just boosted the server ${many[1]} times!`;
  return 'just boosted the server!';
}
