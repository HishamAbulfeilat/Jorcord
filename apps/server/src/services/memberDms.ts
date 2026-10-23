import type { Ctx } from '../ctx';
import { forbidden } from '../errors';

/**
 * Server-level "members may DM each other" policy.
 * A guild with `member_dms_restricted_at` set only lets two members reach each other through it when each side is exempt:
 * the owner, someone who joined before the policy was switched on, or someone who opted in (`members.dm_optin`).
 * One asymmetry: anyone can message the owner (a way to ask for help), but the owner reaches only members who are reachable.
 */
const SIDE = (m: string) => `(g.member_dms_restricted_at IS NULL OR g.owner_id = ${m}.user_id OR ${m}.joined_at < g.member_dms_restricted_at OR ${m}.dm_optin)`;

export interface SharedContext { /** servers both are in */ shared: number; /** of those, servers that allow the two of them to DM */ open: number }
export async function sharedContext(ctx: Ctx, a: string, b: string): Promise<SharedContext> {
  const [r] = await ctx.db.query(
    `SELECT count(*)::int AS shared, count(*) FILTER (WHERE ${SIDE('mb')} AND (${SIDE('ma')} OR mb.user_id = g.owner_id))::int AS open
       FROM members ma JOIN members mb ON mb.guild_id = ma.guild_id JOIN guilds g ON g.id = ma.guild_id WHERE ma.user_id = $1 AND mb.user_id = $2`, [a, b]);
  return { shared: r?.shared ?? 0, open: r?.open ?? 0 };
}

/** Throws when `from` and `to` share servers but every one of them blocks member-to-member DMs for this pair. Friends are not checked here. */
export function assertServerAllowsDm(c: SharedContext) {
  if (c.shared > 0 && c.open === 0) throw forbidden('Direct messages between members of your shared servers are turned off. Send a friend request instead.', 'SERVER_DMS_DISABLED');
}

/** A member's own choice for one server. */
export async function setMemberDmOptIn(ctx: Ctx, guildId: string, userId: string, allow: boolean) {
  await ctx.db.query('UPDATE members SET dm_optin = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, allow]);
}

/** What the member sees for one server: the policy, whether they are exempt from it, and their opt-in. */
export async function memberDmState(ctx: Ctx, guildId: string, userId: string) {
  const [r] = await ctx.db.query(
    `SELECT g.member_dms_restricted_at IS NOT NULL AS restricted, m.dm_optin AS optin, (${SIDE('m')}) AS reachable FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.guild_id = $1 AND m.user_id = $2`, [guildId, userId]);
  return r ? { policy: (r.restricted ? 'optin' : 'open') as 'open' | 'optin', optIn: !!r.optin, reachable: !!r.reachable } : null;
}
