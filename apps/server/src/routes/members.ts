import { uninstallBot } from '../services/apps';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMS, LIMITS, Perm, has, snowflake, type Invite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { clearServerTag } from '../services/cosmetics';
import { bumpDaily } from './guildextras';
import { assertInvitesOpen, detectRaid } from '../services/safety';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, limitParam, parse } from '../lib/ids';
import { randomToken } from '../lib/crypto';
import { limitOrThrow } from '../lib/ratelimit';
import { audit, buildGuildFull } from '../services/guilds';
import { trackVisibility } from '../services/visibility';
import { postSystemMessage } from '../services/messages';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, need, needOutrank, needOutrankMember } from '../services/perms';
import { GUILD_SELECT, guildDTO, liveStatus, memberDTO, membersDTO, roleDTO, usersByIds } from '../services/serializers';

const gid = z.object({ id: idSchema });
const permStr = z.string().regex(/^\d{1,20}$/);
const colorInt = z.number().int().min(0).max(0xffffff);

/** A new member's presence goes out to the guild, and they learn who is already online there. */
async function announceJoin(ctx: Ctx, guildId: string, userId: string) {
  await ctx.hub.broadcastPresence(userId);
  const rows = await ctx.db.query('SELECT u.id, u.presence, u.custom_status FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id <> $2 LIMIT 1000', [guildId, userId]);
  if (ctx.config.redisUrl) ctx.hub.markOnline(await ctx.presence.onlineAmong(rows.map((r) => r.id as string)));
  for (const r of rows) {
    if (!ctx.hub.isOnline(r.id)) continue;
    await ctx.hub.toUser(userId, 'PRESENCE_UPDATE', { userId: r.id, presence: ctx.hub.publicPresence(r.id, r.presence), customStatus: liveStatus(r.custom_status) });
  }
}

/** Shared by invite joins and discoverable-guild joins: ban/limit checks, membership (pending when the guild screens new members), events. */
export async function joinGuild(ctx: Ctx, userId: string, guildId: string, inviteCode: string | null) {
    const [banned] = await ctx.db.query('SELECT 1 AS x FROM bans WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    if (banned) throw forbidden('You are banned from this server', 'BANNED');
    const [already] = await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    if (already) return buildGuildFull(ctx, guildId, userId);
    await assertInvitesOpen(ctx, guildId);
    const [g] = await ctx.db.query('SELECT features, rules_channel_id FROM guilds WHERE id = $1', [guildId]);
    const screening = (g?.features as string[] | undefined)?.includes('MEMBER_SCREENING') === true;
    const [cnt] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE user_id = $1', [userId]);
    if (cnt.n >= LIMITS.maxServersPerUser) throw new ApiError(400, 'MAX_GUILDS', 'Too many servers');
    if (inviteCode) { // atomic use consumption; fails if another joiner took the last use
      const used = await ctx.db.query('UPDATE invites SET uses = uses + 1 WHERE code = $1 AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now()) RETURNING code', [inviteCode]);
      if (!used.length) throw notFound('Invite');
    }
    await ctx.db.query('INSERT INTO members (guild_id, user_id, pending) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [guildId, userId, screening]);
    await ctx.pcache.invalidate({ k: 'member', guildId, userId: userId });
    const full = await buildGuildFull(ctx, guildId, userId);
    await ctx.hub.toUser(userId, 'GUILD_CREATE', full);
    const m = await memberDTO(ctx, guildId, userId);
    if (m) await ctx.hub.toGuild(guildId, 'MEMBER_ADD', m, { exclude: userId });
    await announceJoin(ctx, guildId, userId);
    await bumpDaily(ctx, guildId, 'joins');
    await detectRaid(ctx, guildId).catch((e) => ctx.log.warn({ err: e }, 'raid detection failed'));
    if (full.systemChannelId) await postSystemMessage(ctx, full.systemChannelId, userId, 'join').catch((e) => ctx.log.warn({ err: e }, 'join message failed'));
  return full;
}

export function memberRoutes(app: FastifyInstance, ctx: Ctx) {
  const pushRole = async (guildId: string, id: string) => { const [r] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [id]); if (r) await ctx.hub.toGuild(guildId, 'ROLE_UPDATE', roleDTO(r)); };
  const pushMember = async (guildId: string, userId: string) => { const m = await memberDTO(ctx, guildId, userId); if (m) await ctx.hub.toGuild(guildId, 'MEMBER_UPDATE', m); };
  /** Non-admins cannot grant permission bits they do not hold themselves. */
  const noEscalation = (actorPerms: bigint, bits: bigint) => { if (!has(actorPerms, Perm.ADMINISTRATOR) && (bits & ~actorPerms) !== 0n) throw forbidden('Cannot grant permissions you do not have', 'ESCALATION'); };

  /** Members whose effective permissions depend on a role (everyone for @everyone). */
  const roleHolders = async (guildId: string, roleId: string): Promise<string[]> =>
    roleId === guildId
      ? (await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [guildId])).map((r) => r.user_id as string)
      : (await ctx.db.query('SELECT user_id FROM member_roles WHERE guild_id = $1 AND role_id = $2', [guildId, roleId])).map((r) => r.user_id as string);

  // ---------- roles ----------
  app.get('/guilds/:id/roles', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return (await ctx.db.query('SELECT * FROM roles WHERE guild_id = $1 ORDER BY position DESC, id', [id])).map(roleDTO);
  });
  app.post('/guilds/:id/roles', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), color: colorInt, hoist: z.boolean(), permissions: permStr, mentionable: z.boolean(), icon: z.string().max(2048).nullable() }).partial().strict(), req.body);
    const gp = await guildAccess(ctx, req.userId, id); const perms = guildPerms(gp);
    need(perms, Perm.MANAGE_ROLES);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM roles WHERE guild_id = $1', [id]);
    if (c.n >= 250) throw new ApiError(400, 'MAX_ROLES', 'Role limit reached');
    const bits = BigInt(b.permissions ?? '0'); noEscalation(perms, bits);
    const rid = snowflake();
    await ctx.db.query('UPDATE roles SET position = position + 1 WHERE guild_id = $1 AND position >= 1 AND id <> $1', [id]);
    await ctx.db.query('INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable, icon) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)',
      [rid, id, b.name ?? 'new role', b.color ?? 0, b.hoist ?? false, (bits & ALL_PERMS).toString(), b.mentionable ?? false, b.icon ?? null]);
    await ctx.pcache.invalidate({ k: 'guild', guildId: id });
    await audit(ctx, id, req.userId, 'ROLE_CREATE', rid, b);
    const [row] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [rid]);
    await ctx.hub.toGuild(id, 'ROLE_CREATE', roleDTO(row));
    for (const r of await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND position > 1', [id])) await pushRole(id, r.id);
    return reply.code(201).send(roleDTO(row));
  });
  // reorder (registered before :roleId so the literal path is unambiguous)
  app.patch('/guilds/:id/roles', async (req) => {
    const { id } = parse(gid, req.params);
    const list = parse(z.array(z.object({ id: idSchema, position: z.number().int().min(1).max(1000) }).strict()).min(1).max(250), req.body);
    const gp = await guildAccess(ctx, req.userId, id);
    need(guildPerms(gp), Perm.MANAGE_ROLES);
    const roles = await ctx.db.query('SELECT id, position FROM roles WHERE guild_id = $1', [id]);
    const cur = new Map(roles.map((r) => [r.id, r.position as number]));
    for (const e of list) {
      if (e.id === id || !cur.has(e.id)) throw badRequest('Unknown or immovable role');
      needOutrank(gp, cur.get(e.id)!); needOutrank(gp, e.position);
    }
    await ctx.db.tx(async (q) => { for (const e of list) await q.query('UPDATE roles SET position = $2 WHERE id = $1 AND guild_id = $3', [e.id, e.position, id]); });
    await ctx.pcache.invalidate({ k: 'guild', guildId: id });
    await audit(ctx, id, req.userId, 'ROLE_REORDER', null, list);
    for (const e of list) await pushRole(id, e.id);
    return (await ctx.db.query('SELECT * FROM roles WHERE guild_id = $1 ORDER BY position DESC, id', [id])).map(roleDTO);
  });
  app.patch('/guilds/:id/roles/:roleId', async (req) => {
    const p = parse(z.object({ id: idSchema, roleId: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), color: colorInt, hoist: z.boolean(), permissions: permStr, mentionable: z.boolean(), icon: z.string().max(2048).nullable() }).partial().strict(), req.body);
    const gp = await guildAccess(ctx, req.userId, p.id); const perms = guildPerms(gp);
    need(perms, Perm.MANAGE_ROLES);
    const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1 AND guild_id = $2', [p.roleId, p.id]);
    if (!role) throw notFound('Role');
    if (p.roleId !== p.id) needOutrank(gp, role.position);
    if (p.roleId === p.id && (b.name !== undefined || b.hoist !== undefined || b.color !== undefined)) throw badRequest('@everyone can only have its permissions changed');
    if (b.permissions !== undefined) noEscalation(perms, BigInt(b.permissions) & ~BigInt(role.permissions));
    const col: Record<string, string> = { name: 'name', color: 'color', hoist: 'hoist', permissions: 'permissions', mentionable: 'mentionable', icon: 'icon' };
    const settled = b.permissions !== undefined ? await trackVisibility(ctx, p.id, { userIds: await roleHolders(p.id, p.roleId) }) : null;
    const sets: string[] = [], vals: unknown[] = [p.roleId];
    for (const [k, v] of Object.entries(b)) { vals.push(k === 'permissions' ? (BigInt(v as string) & ALL_PERMS).toString() : v); sets.push(`${col[k]} = $${vals.length}`); }
    if (sets.length) { await ctx.db.query(`UPDATE roles SET ${sets.join(', ')} WHERE id = $1`, vals); await ctx.pcache.invalidate({ k: 'guild', guildId: p.id }); }
    if (settled) await settled();
    await audit(ctx, p.id, req.userId, 'ROLE_UPDATE', p.roleId, b);
    const [row] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [p.roleId]);
    await ctx.hub.toGuild(p.id, 'ROLE_UPDATE', roleDTO(row));
    return roleDTO(row);
  });
  app.delete('/guilds/:id/roles/:roleId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, roleId: idSchema }), req.params);
    const gp = await guildAccess(ctx, req.userId, p.id);
    need(guildPerms(gp), Perm.MANAGE_ROLES);
    const [role0] = await ctx.db.query('SELECT managed_app_id FROM roles WHERE id = $1 AND guild_id = $2', [p.roleId, p.id]);
    if (p.roleId === p.id) throw badRequest('Cannot delete @everyone');
    if (role0?.managed_app_id) throw badRequest('Integration roles are removed by removing the bot');
    const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1 AND guild_id = $2', [p.roleId, p.id]);
    if (!role) throw notFound('Role');
    needOutrank(gp, role.position);
    const holders = (await ctx.db.query('SELECT user_id FROM member_roles WHERE role_id = $1', [p.roleId])).map((r) => r.user_id as string);
    const settled = await trackVisibility(ctx, p.id, { userIds: holders });
    await ctx.db.query('DELETE FROM overwrites WHERE target_id = $1 AND type = \'role\'', [p.roleId]);
    await ctx.db.query('DELETE FROM roles WHERE id = $1', [p.roleId]);
    await ctx.pcache.invalidate({ k: 'guild', guildId: p.id });
    await settled();
    await audit(ctx, p.id, req.userId, 'ROLE_DELETE', p.roleId, { name: role.name });
    await ctx.hub.toGuild(p.id, 'ROLE_DELETE', { id: p.roleId, guildId: p.id });
    for (const u of holders) await pushMember(p.id, u);
    return reply.code(204).send();
  });

  // ---------- members ----------
  app.get('/guilds/:id/members', async (req) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), after: idSchema.optional() }), req.query);
    await guildAccess(ctx, req.userId, id);
    const rows = await ctx.db.query('SELECT * FROM members WHERE guild_id = $1 AND ($2::text IS NULL OR user_id > $2) ORDER BY user_id LIMIT $3', [id, q.after ?? null, limitParam(q.limit)]);
    return membersDTO(ctx, rows);
  });
  app.get('/guilds/:id/members/search', async (req) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ q: z.string().min(1).max(64), limit: z.coerce.number().optional() }), req.query);
    await guildAccess(ctx, req.userId, id);
    const like = `${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await ctx.db.query(
      `SELECT m.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND (u.username ILIKE $2 OR u.display_name ILIKE $2 OR m.nick ILIKE $2) ORDER BY u.username LIMIT $3`, [id, like, limitParam(q.limit, 25, 100)]);
    return membersDTO(ctx, rows);
  });
  app.get('/guilds/:id/members/:userId', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    await guildAccess(ctx, req.userId, p.id);
    const m = await memberDTO(ctx, p.id, p.userId === '@me' ? req.userId : p.userId);
    if (!m) throw notFound('Member');
    return m;
  });

  app.patch('/guilds/:id/members/:userId', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    const b = parse(z.object({ nick: z.string().trim().max(32).nullable(), roles: z.array(idSchema).max(250), timeoutUntil: z.string().datetime().nullable() }).partial().strict(), req.body);
    const targetId = p.userId === '@me' ? req.userId : p.userId;
    const actor = await guildAccess(ctx, req.userId, p.id); const perms = guildPerms(actor);
    const target = await loadGuildPerm(ctx, p.id, targetId);
    if (!target) throw notFound('Member');
    const self = targetId === req.userId;
    if (b.nick !== undefined) {
      if (self) need(perms, Perm.CHANGE_NICKNAME); else { need(perms, Perm.MANAGE_NICKNAMES); needOutrankMember(actor, target); }
      await ctx.db.query('UPDATE members SET nick = $3 WHERE guild_id = $1 AND user_id = $2', [p.id, targetId, b.nick || null]);
      await audit(ctx, p.id, req.userId, 'MEMBER_UPDATE', targetId, { nick: b.nick || null });
    }
    if (b.roles !== undefined) {
      need(perms, Perm.MANAGE_ROLES);
      if (!self) needOutrankMember(actor, target);
      const want = [...new Set(b.roles)].filter((r) => r !== p.id);
      const found = want.length ? await ctx.db.query('SELECT id, position, permissions FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [p.id, want]) : [];
      if (found.length !== want.length) throw badRequest('Unknown role');
      const have = new Set(target.memberRoleIds);
      const pos = (rid: string) => target.rolePos[rid] ?? found.find((f) => f.id === rid)?.position ?? 0;
      const adds = want.filter((r) => !have.has(r)), removes = [...have].filter((r) => !want.includes(r));
      for (const r of [...adds, ...removes]) needOutrank(actor, pos(r)); // may only touch roles strictly below own top role
      for (const r of adds) noEscalation(perms, BigInt(found.find((f) => f.id === r)!.permissions));
      const settled = await trackVisibility(ctx, p.id, { userIds: [targetId] });
      if (removes.length) await ctx.db.query('DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = ANY($3::text[])', [p.id, targetId, removes]);
      for (const r of adds) await ctx.db.query('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [p.id, targetId, r]);
      await ctx.pcache.invalidate({ k: 'member', guildId: p.id, userId: targetId });
      await settled();
      await audit(ctx, p.id, req.userId, 'MEMBER_ROLE_UPDATE', targetId, { added: adds, removed: removes });
    }
    if (b.timeoutUntil !== undefined) {
      need(perms, Perm.MODERATE_MEMBERS);
      if (self) throw badRequest('Cannot time out yourself');
      needOutrankMember(actor, target);
      if (b.timeoutUntil) {
        const t = new Date(b.timeoutUntil).getTime();
        if (t > Date.now() + 28 * 86400_000) throw badRequest('Timeout may not exceed 28 days');
        if (has(await effectiveGuildPerms(p.id, targetId), Perm.ADMINISTRATOR)) throw forbidden('Cannot time out an administrator');
      }
      await ctx.db.query('UPDATE members SET timeout_until = $3 WHERE guild_id = $1 AND user_id = $2', [p.id, targetId, b.timeoutUntil]);
      await ctx.pcache.invalidate({ k: 'member', guildId: p.id, userId: targetId });
      await audit(ctx, p.id, req.userId, 'MEMBER_TIMEOUT', targetId, { until: b.timeoutUntil });
    }
    await pushMember(p.id, targetId);
    return (await memberDTO(ctx, p.id, targetId))!;
  });
  const effectiveGuildPerms = async (guildId: string, userId: string) => { const g = await loadGuildPerm(ctx, guildId, userId); return g ? guildPerms(g) : 0n; };

  async function removeMember(guildId: string, userId: string) {
    await ctx.db.query('DELETE FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    await clearServerTag(ctx, guildId, userId);
    await bumpDaily(ctx, guildId, 'leaves');
    await ctx.pcache.invalidate({ k: 'member', guildId, userId });
    await ctx.hub.toUser(userId, 'GUILD_DELETE', { id: guildId });
    await ctx.hub.toGuild(guildId, 'MEMBER_REMOVE', { guildId, userId });
    await uninstallBot(ctx, guildId, userId); // bots: drop the install record + managed role
  }
  app.delete('/guilds/:id/members/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
    const actor = await guildAccess(ctx, req.userId, p.id);
    need(guildPerms(actor), Perm.KICK_MEMBERS);
    if (p.userId === req.userId) throw badRequest('Cannot kick yourself');
    const target = await loadGuildPerm(ctx, p.id, p.userId);
    if (!target) throw notFound('Member');
    needOutrankMember(actor, target);
    await removeMember(p.id, p.userId);
    await audit(ctx, p.id, req.userId, 'MEMBER_KICK', p.userId);
    return reply.code(204).send();
  });

  // ---------- bans ----------
  app.get('/guilds/:id/bans', async (req) => {
    const { id } = parse(gid, req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.BAN_MEMBERS);
    const rows = await ctx.db.query('SELECT * FROM bans WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 1000', [id]);
    const users = await usersByIds(ctx, rows.map((r) => r.user_id));
    return rows.map((r) => ({ user: users.get(r.user_id), reason: r.reason ?? null, createdAt: iso(r.created_at) }));
  });
  app.put('/guilds/:id/bans/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
    const b = parse(z.object({ reason: z.string().max(512).nullable().optional(), deleteMessageSeconds: z.number().int().min(0).max(604800).optional() }).strict(), req.body);
    const actor = await guildAccess(ctx, req.userId, p.id);
    need(guildPerms(actor), Perm.BAN_MEMBERS);
    if (p.userId === req.userId) throw badRequest('Cannot ban yourself');
    const [u] = await ctx.db.query('SELECT id FROM users WHERE id = $1', [p.userId]);
    if (!u) throw notFound('User');
    const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [p.id]);
    if (g.owner_id === p.userId) throw forbidden('Cannot ban the guild owner', 'HIERARCHY');
    const target = await loadGuildPerm(ctx, p.id, p.userId);
    needOutrankMember(actor, target);
    await ctx.db.query('INSERT INTO bans (guild_id, user_id, reason, banned_by) VALUES ($1,$2,$3,$4) ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = $3, banned_by = $4', [p.id, p.userId, b.reason ?? null, req.userId]);
    await ctx.pcache.invalidate({ k: 'member', guildId: p.id, userId: p.userId });
    if (target) await removeMember(p.id, p.userId);
    if (b.deleteMessageSeconds) {
      const msgs = await ctx.db.query('DELETE FROM messages WHERE guild_id = $1 AND author_id = $2 AND id > $3 RETURNING id, channel_id', [p.id, p.userId, snowflake(Date.now() - b.deleteMessageSeconds * 1000)]);
      for (const m of msgs.slice(0, 1000)) await ctx.hub.toChannel(m.channel_id, 'MESSAGE_DELETE', { id: m.id, channelId: m.channel_id, guildId: p.id });
    }
    await audit(ctx, p.id, req.userId, 'MEMBER_BAN_ADD', p.userId, null, b.reason ?? null);
    return reply.code(204).send();
  });
  app.delete('/guilds/:id/bans/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.BAN_MEMBERS);
    const rows = await ctx.db.query('DELETE FROM bans WHERE guild_id = $1 AND user_id = $2 RETURNING user_id', [p.id, p.userId]);
    if (!rows.length) throw notFound('Ban');
    await audit(ctx, p.id, req.userId, 'MEMBER_BAN_REMOVE', p.userId);
    return reply.code(204).send();
  });

  // ---------- invites ----------
  const inviteDTO = async (r: any, withGuild = false): Promise<Invite> => {
    const base: Invite = { code: r.code, guildId: r.guild_id, channelId: r.channel_id, inviterId: r.inviter_id, uses: r.uses, maxUses: r.max_uses ?? null, expiresAt: iso(r.expires_at), temporary: r.temporary };
    if (!withGuild) return base;
    const [g] = await ctx.db.query('SELECT id, name, icon FROM guilds WHERE id = $1', [r.guild_id]);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [r.guild_id]);
    return { ...base, guild: g, approxMembers: c.n };
  };
  app.get('/guilds/:id/invites', async (req) => {
    const { id } = parse(gid, req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    const rows = await ctx.db.query('SELECT * FROM invites WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
    return Promise.all(rows.map((r) => inviteDTO(r)));
  });
  app.post('/guilds/:id/invites', async (req, reply) => {
    const { id } = parse(gid, req.params);
    limitOrThrow(ctx.rl, `invite-create:${req.userId}`, 20, 3600_000, ctx.config.rateLimit);
    const b = parse(z.object({ channelId: idSchema.optional(), maxUses: z.number().int().min(1).max(1000).nullable().optional(), maxAgeSeconds: z.number().int().min(0).max(30 * 86400).optional(), temporary: z.boolean().optional() }).strict(), req.body);
    await guildAccess(ctx, req.userId, id);
    let channelId = b.channelId;
    if (!channelId) {
      const [c] = await ctx.db.query(`SELECT COALESCE((SELECT system_channel_id FROM guilds WHERE id = $1), (SELECT id FROM channels WHERE guild_id = $1 AND type IN ('text','announcement') ORDER BY position LIMIT 1)) AS id`, [id]);
      channelId = c?.id; if (!channelId) throw badRequest('Guild has no channel to invite to');
    }
    const a = await channelAccess(ctx, req.userId, channelId);
    if (a.channel.guild_id !== id) throw badRequest('Channel is not in this guild');
    need(a.perms, Perm.CREATE_INVITE);
    const age = b.maxAgeSeconds ?? 86400;
    const code = randomToken(6).replace(/[-_]/g, 'x');
    await ctx.db.query('INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, expires_at, temporary) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [code, id, channelId, req.userId, b.maxUses ?? null, age ? new Date(Date.now() + age * 1000) : null, b.temporary ?? false]);
    await audit(ctx, id, req.userId, 'INVITE_CREATE', code);
    return reply.code(201).send(await inviteDTO((await ctx.db.query('SELECT * FROM invites WHERE code = $1', [code]))[0], true));
  });
  app.post('/invites/:code', async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/) }), req.params);
    limitOrThrow(ctx.rl, `invite-join:${req.userId}`, 20, 15 * 60_000, ctx.config.rateLimit); // code/vanity guessing + join spam
    let guildId: string;
    const [existing] = await ctx.db.query('SELECT * FROM invites WHERE code = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses)', [code]);
    const [vanity] = existing ? [] : await ctx.db.query('SELECT id FROM guilds WHERE lower(vanity_url) = lower($1)', [code]);
    if (!existing && !vanity) throw notFound('Invite');
    guildId = existing ? existing.guild_id : vanity.id;
    const full = await joinGuild(ctx, req.userId, guildId, existing ? code : null);
    return reply.code(200).send(full);
  });
  // ---------- discoverable guilds & membership screening ----------
  const joinDiscoverable = async (req: any) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    limitOrThrow(ctx.rl, `invite-join:${req.userId}`, 20, 15 * 60_000, ctx.config.rateLimit);
    const [g] = await ctx.db.query('SELECT features FROM guilds WHERE id = $1', [id]);
    if (!g || !(g.features as string[]).includes('DISCOVERABLE')) throw notFound('Guild'); // non-discoverable guilds are indistinguishable from missing ones
    return joinGuild(ctx, req.userId, id, null);
  };
  app.post('/discover/guilds/:id/join', async (req, reply) => reply.code(200).send(await joinDiscoverable(req)));
  app.post('/guilds/:id/join', async (req, reply) => reply.code(200).send(await joinDiscoverable(req))); // alias used by the web client

  /** What a pending member must read before accepting. */
  app.get('/guilds/:id/screening', async (req) => {
    const { id } = parse(gid, req.params);
    await guildAccess(ctx, req.userId, id);
    const [g] = await ctx.db.query('SELECT description, rules_channel_id, features FROM guilds WHERE id = $1', [id]);
    const [m] = await ctx.db.query('SELECT pending FROM members WHERE guild_id = $1 AND user_id = $2', [id, req.userId]);
    return { enabled: (g.features as string[]).includes('MEMBER_SCREENING'), rulesChannelId: g.rules_channel_id ?? null, description: g.description ?? null, pending: !!m?.pending };
  });
  /** Accepting the rules lifts the read-only restriction. Idempotent. */
  app.put('/guilds/:id/members/@me/screening', async (req) => {
    const { id } = parse(gid, req.params);
    parse(z.object({ acceptRules: z.literal(true) }).strict(), req.body);
    await guildAccess(ctx, req.userId, id);
    const up = await ctx.db.query('UPDATE members SET pending = false WHERE guild_id = $1 AND user_id = $2 AND pending RETURNING user_id', [id, req.userId]);
    if (up.length) { await ctx.pcache.invalidate({ k: 'member', guildId: id, userId: req.userId }); await pushMember(id, req.userId); }
    return (await memberDTO(ctx, id, req.userId))!;
  });

  app.delete('/invites/:code', async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/) }), req.params);
    const [inv] = await ctx.db.query('SELECT * FROM invites WHERE code = $1', [code]);
    if (!inv) throw notFound('Invite');
    const gp = await loadGuildPerm(ctx, inv.guild_id, req.userId);
    if (!gp) throw notFound('Invite');
    if (inv.inviter_id !== req.userId) need(guildPerms(gp), Perm.MANAGE_GUILD);
    await ctx.db.query('DELETE FROM invites WHERE code = $1', [code]);
    await audit(ctx, inv.guild_id, req.userId, 'INVITE_DELETE', code);
    return reply.code(204).send();
  });
}

export function invitePublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/invites/:code', async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/) }), req.params);
    limitOrThrow(ctx.rl, `invite-peek:${req.ip}`, 60, 60_000, ctx.config.rateLimit); // unauthenticated: stop code enumeration
    const [r] = await ctx.db.query('SELECT * FROM invites WHERE code = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses)', [code]);
    if (!r) throw notFound('Invite');
    const [g] = await ctx.db.query('SELECT id, name, icon FROM guilds WHERE id = $1', [r.guild_id]);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [r.guild_id]);
    const inv: Invite = { code: r.code, guildId: r.guild_id, channelId: r.channel_id, inviterId: r.inviter_id, uses: r.uses, maxUses: r.max_uses ?? null, expiresAt: iso(r.expires_at), temporary: r.temporary, guild: g, approxMembers: c.n };
    return inv;
  });
}
export { GUILD_SELECT, guildDTO };
