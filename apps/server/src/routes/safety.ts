import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, normalizeLinkList } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { idSchema, parse } from '../lib/ids';
import { audit } from '../services/guilds';
import { clearImpersonation, normalizeGuard } from '../services/impersonation';
import { memberDmState, setMemberDmOptIn } from '../services/memberDms';
import { notFound } from '../errors';
import { iso } from '../lib/ids';
import { guildAccess, guildPerms, need } from '../services/perms';
import { SAFETY_PRESETS, normalizeRaid, safetyDTO } from '../services/safety';
import { GUILD_SELECT, guildDTO } from '../services/serializers';

const patchSafety = z.object({
  verificationLevel: z.number().int().min(0).max(4), explicitFilter: z.number().int().min(0).max(2), defaultNotifications: z.enum(['all', 'mentions']),
  raidProtection: z.object({ enabled: z.boolean(), maxJoins: z.number().int().min(3).max(100), windowSeconds: z.number().int().min(10).max(600), lockMinutes: z.number().int().min(5).max(1440) }).partial().strict(),
  /** true pauses invites/joins for 24 h, false resumes them */ pauseInvites: z.boolean(),
  /** 'optin': members who join from now on (or everyone, with applyToExisting) must opt in before other members can DM them through this server */ memberDms: z.enum(['open', 'optin']), memberDmsApplyToExisting: z.boolean(),
  linkAllow: z.array(z.string().max(253)).max(100), linkDeny: z.array(z.string().max(253)).max(100),
  impersonationGuard: z.object({ enabled: z.boolean(), action: z.enum(['flag', 'hold']) }).partial().strict(),
}).partial().strict();

/** Safety Setup: verification level, explicit-media filter, default notifications, raid protection and the invite pause. All MANAGE_GUILD. */
export function safetyRoutes(app: FastifyInstance, ctx: Ctx) {
  const gid = z.object({ id: idSchema });
  const load = async (id: string) => (await ctx.db.query('SELECT * FROM guilds WHERE id = $1', [id]))[0];
  const apply = async (id: string, actor: string, b: z.infer<typeof patchSafety>) => {
    const cur = await load(id);
    const sets: string[] = []; const vals: unknown[] = [id];
    const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
    if (b.verificationLevel !== undefined) set('verification_level', b.verificationLevel);
    if (b.explicitFilter !== undefined) set('explicit_filter', b.explicitFilter);
    if (b.defaultNotifications !== undefined) set('default_notifications', b.defaultNotifications);
    if (b.raidProtection) set('raid_protection', JSON.stringify(normalizeRaid({ ...normalizeRaid(cur.raid_protection), ...b.raidProtection })), '::jsonb');
    if (b.memberDms === 'open') sets.push('member_dms_restricted_at = NULL');
    if (b.memberDms === 'optin') { if (b.memberDmsApplyToExisting) sets.push("member_dms_restricted_at = 'epoch'"); else sets.push('member_dms_restricted_at = COALESCE(member_dms_restricted_at, now())'); }
    if (b.linkAllow) set('link_allow', JSON.stringify(normalizeLinkList(b.linkAllow)), '::jsonb');
    if (b.linkDeny) set('link_deny', JSON.stringify(normalizeLinkList(b.linkDeny)), '::jsonb');
    if (b.impersonationGuard) set('impersonation_guard', JSON.stringify(normalizeGuard({ ...normalizeGuard(cur.impersonation_guard), ...b.impersonationGuard })), '::jsonb');
    if (b.pauseInvites !== undefined) set('invites_paused_until', b.pauseInvites ? new Date(Date.now() + 86_400_000) : null);
    if (!sets.length) return;
    await ctx.db.query(`UPDATE guilds SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(ctx, id, actor, 'SAFETY_UPDATE', id, b);
    const [fresh] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [id]);
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', guildDTO(fresh));
  };
  const gate = async (userId: string, id: string) => { need(guildPerms(await guildAccess(ctx, userId, id)), Perm.MANAGE_GUILD); };

  app.get('/guilds/:id/safety', async (req) => { const { id } = parse(gid, req.params); await gate(req.userId, id); return safetyDTO(await load(id)); });
  app.patch('/guilds/:id/safety', async (req) => {
    const { id } = parse(gid, req.params); const b = parse(patchSafety, req.body); await gate(req.userId, id);
    await apply(id, req.userId, b); return safetyDTO(await load(id));
  });
  /** One click: apply a preset (basic | recommended | strict). Does not touch an active invite pause. */
  app.post('/guilds/:id/safety/preset', async (req) => {
    const { id } = parse(gid, req.params); const { preset } = parse(z.object({ preset: z.enum(['basic', 'recommended', 'strict']) }).strict(), req.body); await gate(req.userId, id);
    await apply(id, req.userId, SAFETY_PRESETS[preset] as any); return safetyDTO(await load(id));
  });

  // ---------- members may DM each other (per member) ----------
  const mid = z.object({ id: idSchema });
  app.get('/guilds/:id/members/@me/dms', async (req) => {
    const { id } = parse(mid, req.params); await guildAccess(ctx, req.userId, id);
    return (await memberDmState(ctx, id, req.userId)) ?? (() => { throw notFound('Member'); })();
  });
  app.put('/guilds/:id/members/@me/dms', async (req) => {
    const { id } = parse(mid, req.params); const { allow } = parse(z.object({ allow: z.boolean() }).strict(), req.body); await guildAccess(ctx, req.userId, id);
    await setMemberDmOptIn(ctx, id, req.userId, allow);
    return (await memberDmState(ctx, id, req.userId))!;
  });

  // ---------- impersonation review queue ----------
  const modGate = async (userId: string, id: string) => { const p = guildPerms(await guildAccess(ctx, userId, id)); if (!(p & (Perm.MODERATE_MEMBERS | Perm.MANAGE_GUILD | Perm.KICK_MEMBERS | Perm.BAN_MEMBERS))) need(p, Perm.MODERATE_MEMBERS); };
  app.get('/guilds/:id/safety/impersonation', async (req) => {
    const { id } = parse(mid, req.params); await modGate(req.userId, id);
    const rows = await ctx.db.query(
      `SELECT m.user_id, m.impersonation_flag, m.safety_hold, m.joined_at, u.username, u.display_name, u.avatar, u.created_at FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.guild_id = $1 AND m.impersonation_flag IS NOT NULL ORDER BY m.joined_at DESC LIMIT 100`, [id]);
    return rows.map((r) => ({ userId: r.user_id, username: r.username, displayName: r.display_name ?? null, avatar: r.avatar ?? null, accountCreatedAt: iso(r.created_at)!, joinedAt: iso(r.joined_at)!, held: !!r.safety_hold, match: r.impersonation_flag }));
  });
  app.post('/guilds/:id/members/:userId/impersonation/clear', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params); await modGate(req.userId, p.id);
    const done = await clearImpersonation(ctx, p.id, p.userId);
    if (!done) throw notFound('Flag');
    await audit(ctx, p.id, req.userId, 'IMPERSONATION_CLEARED', p.userId);
    return { cleared: true };
  });
}
