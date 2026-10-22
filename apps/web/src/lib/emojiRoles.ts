import { Perm, has } from '@jorcord/shared';
import type { Emoji, Id } from '@jorcord/shared';

/** Role-restricted emoji: usable with no restriction, a matching role, or MANAGE_EMOJIS (mirrors the server rule). */
export function canUseEmoji(e: Pick<Emoji, 'roleIds'>, myRoleIds: Id[] | undefined, perms: bigint): boolean {
  if (!e.roleIds?.length) return true;
  return has(perms, Perm.MANAGE_EMOJIS) || (myRoleIds ?? []).some((r) => e.roleIds!.includes(r));
}
