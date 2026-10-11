import type { Ctx } from '../ctx';
import { memberDTO } from './serializers';
import { trackVisibility } from './visibility';

/**
 * Server-driven role changes (booster role, linked roles). Writes member_roles, refreshes the permission cache, re-evaluates channel
 * visibility for that member and tells the guild. Returns true when anything changed.
 */
export async function applyRoleChanges(ctx: Ctx, guildId: string, userId: string, adds: string[], removes: string[]): Promise<boolean> {
  const have = new Set((await ctx.db.query('SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).map((r) => r.role_id as string));
  const add = [...new Set(adds)].filter((r) => !have.has(r)), rem = [...new Set(removes)].filter((r) => have.has(r) && !adds.includes(r));
  if (!add.length && !rem.length) return false;
  const settled = await trackVisibility(ctx, guildId, { userIds: [userId] });
  if (rem.length) await ctx.db.query('DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = ANY($3::text[])', [guildId, userId, rem]);
  for (const r of add) await ctx.db.query('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [guildId, userId, r]);
  await ctx.pcache.invalidate({ k: 'member', guildId, userId });
  await settled();
  const m = await memberDTO(ctx, guildId, userId); if (m) await ctx.hub.toGuild(guildId, 'MEMBER_UPDATE', m);
  return true;
}
