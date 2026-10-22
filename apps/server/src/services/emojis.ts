import { Perm, has } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { forbidden } from '../errors';

const CUSTOM_EMOJI = /<a?:\w{2,32}:(\d{1,20})>/g;

/** Whether a member may use an emoji restricted to `roleIds`: no restriction, a matching role, or an emoji manager. */
export function canUseEmoji(roleIds: string[] | null | undefined, memberRoleIds: string[] | undefined, perms: bigint): boolean {
  if (!roleIds?.length) return true;
  return has(perms, Perm.MANAGE_EMOJIS) || (memberRoleIds ?? []).some((r) => roleIds.includes(r));
}

/** Throws 403 `EMOJI_RESTRICTED` when `content` contains a role-restricted custom emoji of this guild the sender may not use. */
export async function assertEmojiAllowed(ctx: Ctx, guildId: string | null, content: string, memberRoleIds: string[] | undefined, perms: bigint) {
  if (!guildId || !content.includes('<')) return;
  const ids = [...new Set([...content.matchAll(CUSTOM_EMOJI)].map((m) => m[1]!))].slice(0, 50);
  if (!ids.length) return;
  const rows = await ctx.db.query(`SELECT id, name, role_ids FROM emojis WHERE guild_id = $1 AND id = ANY($2::text[]) AND role_ids <> '[]'::jsonb`, [guildId, ids]);
  for (const r of rows) if (!canUseEmoji(r.role_ids, memberRoleIds, perms)) throw forbidden(`The :${r.name}: emoji is restricted to certain roles`, 'EMOJI_RESTRICTED');
}
