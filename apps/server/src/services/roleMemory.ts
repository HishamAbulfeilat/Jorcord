import { Perm, restorableRoles, type CurrentRole, type Grantor } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { audit } from './guilds';
import { guildPerms, loadGuildPerm } from './perms';
import { loadModSettings } from './modSettings';

export type RememberReason = 'kick' | 'leave' | 'timeout';

/**
 * Called just before a member is removed. Keeps their (non-managed) roles for `rememberRoles.days` so a rejoin can get them back, and keeps an
 * active timeout so leaving and rejoining cannot shake it off. `force` is the moderator's own choice in the kick dialog (false = do not remember
 * roles this time); it can switch remembering off but never on when the server turned the feature off. Returns whether anything was stored.
 */
export async function rememberRoles(ctx: Ctx, guildId: string, userId: string, o: { reason: RememberReason; grantedBy: string | null; force?: boolean }): Promise<boolean> {
  const s = await loadModSettings(ctx, guildId);
  const [m] = await ctx.db.query('SELECT timeout_until FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (!m) return false;
  const timedOut = m.timeout_until && new Date(m.timeout_until).getTime() > Date.now() ? new Date(m.timeout_until) : null;
  const wantRoles = s.rememberRoles.enabled && o.force !== false && (o.reason === 'kick' ? s.rememberRoles.onKick : o.reason === 'leave' ? s.rememberRoles.onLeave : true);
  const roles = wantRoles
    ? await ctx.db.query(`SELECT r.id, r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.guild_id = $1 AND mr.user_id = $2 AND r.managed_kind IS NULL AND r.managed_app_id IS NULL AND r.id <> $1`, [guildId, userId])
    : [];
  if (!roles.length && !timedOut) return false;
  await ctx.db.query(
    `INSERT INTO member_role_memory (guild_id, user_id, roles, timeout_until, granted_by, reason, expires_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6, now() + ($7::int * interval '1 day'))
     ON CONFLICT (guild_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, timeout_until = EXCLUDED.timeout_until, granted_by = EXCLUDED.granted_by,
       reason = EXCLUDED.reason, created_at = now(), expires_at = EXCLUDED.expires_at`,
    [guildId, userId, JSON.stringify(roles.map((r) => ({ id: r.id, permissions: String(r.permissions) }))), timedOut, o.grantedBy, o.reason, Math.max(1, s.rememberRoles.days)]);
  return true;
}

/** Called right after a member (re)joins. Applies what {@link rememberRoles} kept, re-checking every role against the server as it is now. */
export async function restoreRoles(ctx: Ctx, guildId: string, userId: string): Promise<{ restored: string[]; skipped: { id: string; why: string }[]; timeoutRestored: boolean } | null> {
  const [mem] = await ctx.db.query('DELETE FROM member_role_memory WHERE guild_id = $1 AND user_id = $2 RETURNING *', [guildId, userId]); // consumed: one restore per removal
  if (!mem || new Date(mem.expires_at).getTime() <= Date.now()) return null;
  const s = await loadModSettings(ctx, guildId);
  const remembered = (Array.isArray(mem.roles) ? mem.roles : []) as { id: string; permissions: string }[];
  const rows = remembered.length ? await ctx.db.query('SELECT id, position, permissions, managed_kind, managed_app_id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [guildId, remembered.map((r) => r.id)]) : [];
  const current = new Map<string, CurrentRole>(rows.map((r) => [r.id as string, { id: r.id, position: r.position, permissions: String(r.permissions), managed: !!(r.managed_kind || r.managed_app_id) }]));
  let grantor: Grantor | null = null;
  if (mem.granted_by) {
    const gp = await loadGuildPerm(ctx, guildId, mem.granted_by);
    if (gp) { const perms = guildPerms(gp); grantor = { isOwner: gp.isOwner, administrator: (perms & Perm.ADMINISTRATOR) !== 0n, topPosition: gp.topPosition, perms }; }
  }
  const plan = s.rememberRoles.enabled ? restorableRoles(guildId, remembered, current, grantor) : { restore: [], skipped: [] };
  for (const id of plan.restore) await ctx.db.query('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [guildId, userId, id]);
  const timeoutRestored = !!mem.timeout_until && new Date(mem.timeout_until).getTime() > Date.now();
  if (timeoutRestored) await ctx.db.query('UPDATE members SET timeout_until = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, mem.timeout_until]);
  await ctx.pcache.invalidate({ k: 'member', guildId, userId });
  if (plan.restore.length || timeoutRestored || plan.skipped.length)
    await audit(ctx, guildId, userId, 'MEMBER_ROLES_RESTORED', userId, { restored: plan.restore, skipped: plan.skipped, timeoutRestored, removedBy: mem.reason }, null, { before: { roles: [] }, after: { roles: plan.restore } });
  return { restored: plan.restore, skipped: plan.skipped.map((x) => ({ id: x.id, why: x.why })), timeoutRestored };
}

/** Housekeeping: forget expired memories. */
export async function sweepRoleMemory(ctx: Ctx) {
  await ctx.db.query('DELETE FROM member_role_memory WHERE expires_at < now()');
}
