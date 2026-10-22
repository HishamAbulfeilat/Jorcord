/** Public user flags (bitfield on `User.publicFlags`), shown as profile badges. Assigned by the instance admin; STAFF is implied for the super admin. */
export const UserFlags = {
  STAFF: 1 << 0,
  PARTNER: 1 << 1,
  BUG_HUNTER: 1 << 3,
  EARLY_SUPPORTER: 1 << 9,
  VERIFIED_BOT: 1 << 16,
  CERTIFIED_MODERATOR: 1 << 18,
  ACTIVE_DEVELOPER: 1 << 22,
} as const;
export type UserFlagName = keyof typeof UserFlags;

/** Badge catalogue in display order (original labels; the client picks the icon). */
export const USER_BADGES: { flag: UserFlagName; label: string; description: string }[] = [
  { flag: 'STAFF', label: 'Staff', description: 'Runs this Jorcord instance' },
  { flag: 'PARTNER', label: 'Partner', description: 'Partnered community owner' },
  { flag: 'CERTIFIED_MODERATOR', label: 'Certified Moderator', description: 'Trusted community moderator' },
  { flag: 'ACTIVE_DEVELOPER', label: 'Active Developer', description: 'Builds apps on Jorcord' },
  { flag: 'BUG_HUNTER', label: 'Bug Hunter', description: 'Found and reported bugs' },
  { flag: 'EARLY_SUPPORTER', label: 'Early Supporter', description: 'Was here early' },
  { flag: 'VERIFIED_BOT', label: 'Verified Bot', description: 'A verified application' },
];

/** All flag bits that are valid in `publicFlags`. */
export const ALL_USER_FLAGS = Object.values(UserFlags).reduce((a, b) => a | b, 0);

export const hasUserFlag = (flags: number | undefined | null, f: UserFlagName): boolean => ((flags ?? 0) & UserFlags[f]) !== 0;
export const userBadges = (flags: number | undefined | null) => USER_BADGES.filter((b) => hasUserFlag(flags, b.flag));
