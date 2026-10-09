import { ALL_PERMS, DEFAULT_EVERYONE, Perm, computePermissions, has, type Overwrite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { forbidden, notFound } from '../errors';

export interface GuildPerm {
  guildId: string; userId: string; ownerId: string; isOwner: boolean; everyoneId: string;
  everyonePerms: bigint; rolePerms: Record<string, bigint>; rolePos: Record<string, number>;
  memberRoleIds: string[]; timedOut: boolean; topPosition: number;
}

/** Loads permission inputs for many users of one guild (null entry = not a member). 4 queries total. */
export async function loadGuildPerms(ctx: Ctx, guildId: string, userIds: string[]): Promise<Map<string, GuildPerm>> {
  const out = new Map<string, GuildPerm>();
  if (!userIds.length) return out;
  const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
  if (!g) return out;
  const roles = await ctx.db.query('SELECT id, permissions, position FROM roles WHERE guild_id = $1', [guildId]);
  const members = await ctx.db.query('SELECT user_id, timeout_until FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])', [guildId, userIds]);
  const mr = await ctx.db.query('SELECT user_id, role_id FROM member_roles WHERE guild_id = $1 AND user_id = ANY($2::text[])', [guildId, userIds]);
  const rolePerms: Record<string, bigint> = {}, rolePos: Record<string, number> = {};
  for (const r of roles) { rolePerms[r.id] = BigInt(r.permissions); rolePos[r.id] = r.position; }
  const everyonePerms = rolePerms[guildId] ?? DEFAULT_EVERYONE;
  const now = Date.now();
  for (const m of members) {
    const ids = mr.filter((x) => x.user_id === m.user_id && rolePerms[x.role_id] !== undefined).map((x) => x.role_id as string);
    out.set(m.user_id, {
      guildId, userId: m.user_id, ownerId: g.owner_id, isOwner: g.owner_id === m.user_id, everyoneId: guildId, everyonePerms,
      rolePerms, rolePos, memberRoleIds: ids, timedOut: !!m.timeout_until && new Date(m.timeout_until).getTime() > now,
      topPosition: ids.reduce((a, id) => Math.max(a, rolePos[id] ?? 0), 0),
    });
  }
  return out;
}
export async function loadGuildPerm(ctx: Ctx, guildId: string, userId: string): Promise<GuildPerm | null> {
  return (await loadGuildPerms(ctx, guildId, [userId])).get(userId) ?? null;
}

export function permsFor(gp: GuildPerm, overwrites: Overwrite[] = []): bigint {
  return computePermissions({
    isOwner: gp.isOwner, everyoneRoleId: gp.everyoneId, everyonePerms: gp.everyonePerms, memberRoleIds: gp.memberRoleIds,
    rolePerms: gp.rolePerms, memberId: gp.userId, overwrites, timedOut: gp.timedOut,
  });
}
export async function loadOverwrites(ctx: Ctx, channelId: string): Promise<Overwrite[]> {
  const rows = await ctx.db.query('SELECT * FROM overwrites WHERE channel_id = $1', [channelId]);
  return rows.map((o) => ({ id: o.target_id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
}

export const DM_PERMS = Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY | Perm.ADD_REACTIONS | Perm.ATTACH_FILES |
  Perm.EMBED_LINKS | Perm.USE_EXTERNAL_EMOJIS | Perm.CONNECT | Perm.SPEAK | Perm.STREAM | Perm.USE_VAD;

export async function getChannelRow(ctx: Ctx, id: string) {
  return (await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]))[0] ?? null;
}

export interface Access { channel: any; perms: bigint; gp: GuildPerm | null; permChannel: any }
/** Resolve a channel for a user. Throws 404 if the channel is missing OR not viewable (avoids existence leaks). */
export async function channelAccess(ctx: Ctx, userId: string, channelId: string, opts: { requireView?: boolean } = {}): Promise<Access> {
  const channel = await getChannelRow(ctx, channelId);
  if (!channel) throw notFound('Channel');
  if (!channel.guild_id) {
    const [p] = await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
    if (!p) throw notFound('Channel');
    return { channel, perms: DM_PERMS, gp: null, permChannel: channel };
  }
  const gp = await loadGuildPerm(ctx, channel.guild_id, userId);
  if (!gp) throw notFound('Channel');
  // threads inherit the parent's overwrites
  const permChannel = channel.type === 'thread' && channel.parent_id ? (await getChannelRow(ctx, channel.parent_id)) ?? channel : channel;
  const perms = permsFor(gp, await loadOverwrites(ctx, permChannel.id));
  if (opts.requireView !== false && !has(perms, Perm.VIEW_CHANNEL)) throw notFound('Channel');
  return { channel, perms, gp, permChannel };
}
export function need(perms: bigint, ...bits: bigint[]) {
  for (const b of bits) if (!has(perms, b)) throw forbidden('Missing permissions');
}
export async function guildAccess(ctx: Ctx, userId: string, guildId: string): Promise<GuildPerm> {
  const gp = await loadGuildPerm(ctx, guildId, userId);
  if (!gp) throw notFound('Guild');
  return gp;
}
export const guildPerms = (gp: GuildPerm) => permsFor(gp);
/** Throws unless actor strictly outranks the position (owner always passes). */
export function needOutrank(actor: GuildPerm, position: number) {
  if (!actor.isOwner && actor.topPosition <= position) throw forbidden('Role hierarchy forbids this action', 'HIERARCHY');
}
export function needOutrankMember(actor: GuildPerm, target: GuildPerm | null) {
  if (!target) return;
  if (target.isOwner) throw forbidden('Cannot act on the guild owner', 'HIERARCHY');
  if (actor.userId === target.userId) return;
  needOutrank(actor, target.topPosition);
}

/** Users (among candidates) who can VIEW_CHANNEL on a guild channel. */
export async function viewersAmong(ctx: Ctx, channel: any, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return [];
  if (!channel.guild_id) {
    const rows = await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND user_id = ANY($2::text[])', [channel.id, candidates]);
    return rows.map((r) => r.user_id);
  }
  const permChannelId = channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id;
  const ow = await loadOverwrites(ctx, permChannelId);
  const gps = await loadGuildPerms(ctx, channel.guild_id, candidates);
  return [...gps.values()].filter((gp) => has(permsFor(gp, ow), Perm.VIEW_CHANNEL)).map((g) => g.userId);
}
export { ALL_PERMS, Perm, has };
