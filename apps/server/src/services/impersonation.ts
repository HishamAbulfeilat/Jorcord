import { DEFAULT_IMPERSONATION_GUARD, IMPERSONATION_ACTIONS, Perm, matchImpersonation, type ImpersonationGuard, type ImpersonationTarget } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { audit } from './guilds';

export function normalizeGuard(raw: unknown): ImpersonationGuard {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ImpersonationGuard>;
  return { enabled: r.enabled === true, action: (IMPERSONATION_ACTIONS as readonly string[]).includes(r.action as string) ? (r.action as ImpersonationGuard['action']) : DEFAULT_IMPERSONATION_GUARD.action };
}

const STAFF_BITS = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD | Perm.MODERATE_MEMBERS | Perm.BAN_MEMBERS | Perm.KICK_MEMBERS;
const MAX_STAFF = 40;

/** Names worth imitating: the owner, members whose roles carry moderation powers, and the server's own name. */
export async function impersonationTargets(ctx: Ctx, guildId: string): Promise<ImpersonationTarget[]> {
  const [g] = await ctx.db.query('SELECT name, owner_id FROM guilds WHERE id = $1', [guildId]);
  if (!g) return [];
  const roles = (await ctx.db.query('SELECT id, permissions FROM roles WHERE guild_id = $1', [guildId])).filter((r) => (BigInt(r.permissions) & STAFF_BITS) !== 0n).map((r) => r.id as string);
  const staff = roles.length ? await ctx.db.query('SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[]) LIMIT $3', [guildId, roles, MAX_STAFF]) : [];
  const ids = [...new Set([g.owner_id as string, ...staff.map((r) => r.user_id as string)])];
  const people = await ctx.db.query(
    `SELECT u.id, u.username, u.display_name, m.nick FROM users u LEFT JOIN members m ON m.user_id = u.id AND m.guild_id = $2 WHERE u.id = ANY($1::text[]) AND NOT u.bot`, [ids, guildId]);
  const out: ImpersonationTarget[] = [{ kind: 'server', name: g.name }];
  for (const p of people) {
    const kind = p.id === g.owner_id ? 'owner' : 'staff';
    for (const name of new Set([p.username, p.display_name, p.nick].filter((x): x is string => typeof x === 'string' && x.length >= 4))) out.push({ kind, name, userId: p.id });
  }
  return out;
}

/**
 * Compares one member's username, display name and nickname with the guild's targets. A match is recorded on the member (`impersonation_flag`)
 * and, when the guard is set to "hold", the member is read-only until a moderator clears them. Returns the match, if any.
 */
export async function checkImpersonation(ctx: Ctx, guildId: string, userId: string) {
  const [g] = await ctx.db.query('SELECT impersonation_guard, owner_id FROM guilds WHERE id = $1', [guildId]);
  const guard = normalizeGuard(g?.impersonation_guard);
  if (!g || !guard.enabled || g.owner_id === userId) return null;
  const [u] = await ctx.db.query('SELECT username, display_name, bot FROM users WHERE id = $1', [userId]);
  const [m] = await ctx.db.query('SELECT nick FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (!u || u.bot || !m) return null;
  const all = await impersonationTargets(ctx, guildId);
  if (all.some((t) => t.userId === userId)) return null; // staff and the owner are the ones being protected
  const targets = all;
  for (const name of [u.username, u.display_name, m.nick]) {
    if (typeof name !== 'string') continue;
    const hit = matchImpersonation(name, targets);
    if (!hit) continue;
    const flag = { kind: hit.kind, target: hit.target, name: hit.candidate, distance: hit.distance, at: new Date().toISOString() };
    const hold = guard.action === 'hold';
    const rows = await ctx.db.query('UPDATE members SET impersonation_flag = $3::jsonb, safety_hold = $4 WHERE guild_id = $1 AND user_id = $2 AND (impersonation_flag IS NULL OR impersonation_flag->>\'name\' IS DISTINCT FROM $5) RETURNING user_id', [guildId, userId, JSON.stringify(flag), hold, hit.candidate]);
    if (rows.length) {
      await ctx.pcache.invalidate({ k: 'member', guildId, userId });
      await audit(ctx, guildId, userId, 'IMPERSONATION_FLAGGED', userId, { ...flag, action: guard.action }, `Name resembles ${hit.kind === 'server' ? 'the server name' : hit.kind === 'owner' ? 'the owner' : 'a moderator'} "${hit.target}"`);
    }
    return hit;
  }
  return null;
}

/** A moderator reviewed the member: remove the flag and any hold. */
export async function clearImpersonation(ctx: Ctx, guildId: string, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('UPDATE members SET impersonation_flag = NULL, safety_hold = false WHERE guild_id = $1 AND user_id = $2 AND (impersonation_flag IS NOT NULL OR safety_hold) RETURNING user_id', [guildId, userId]);
  if (rows.length) await ctx.pcache.invalidate({ k: 'member', guildId, userId });
  return rows.length > 0;
}
