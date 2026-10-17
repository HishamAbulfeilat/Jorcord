import type { Member, User } from '@jorcord/shared';

type ProfileUser = Pick<User, 'avatar' | 'banner' | 'bio' | 'pronouns'>;
type ProfileMember = Pick<Member, 'avatar' | 'banner' | 'bio' | 'pronouns'>;

/** A member value wins only when it is actually set; an empty string counts as unset. */
const pick = (memberVal: string | null | undefined, userVal: string | null | undefined): string | null =>
  memberVal != null && memberVal !== '' ? memberVal : userVal ?? null;

/**
 * Resolve the profile fields to display for a user in a server.
 * Per-server overrides (self-only) win; anything unset falls back to the user-level field.
 */
export function memberProfile(user: ProfileUser | null | undefined, member?: ProfileMember | null) {
  return {
    avatar: pick(member?.avatar, user?.avatar),
    banner: pick(member?.banner, user?.banner),
    bio: pick(member?.bio, user?.bio),
    pronouns: pick(member?.pronouns, user?.pronouns),
  };
}
