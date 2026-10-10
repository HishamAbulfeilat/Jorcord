import { ALL_PERMS, DEFAULT_EVERYONE, Perm, computePermissions, has, type Overwrite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { forbidden, notFound } from '../errors';
import type { ChannelLite } from './permcache';

export interface GuildPerm {
  guildId: string; userId: string; ownerId: string; isOwner: boolean; everyoneId: string;
  everyonePerms: bigint; rolePerms: Record<string, bigint>; rolePos: Record<string, number>;
  memberRoleIds: string[]; timedOut: boolean; topPosition: number;
}

/** Loads permission inputs for many users of one guild (absent entry = not a member). Served from the in-process PermCache. */
export async function loadGuildPerms(ctx: Ctx, guildId: string, userIds: string[]): Promise<Map<string, GuildPerm>> {
  const out = new Map<string, GuildPerm>();
  if (!userIds.length) return out;
  const r = await ctx.pcache.guildMembers(ctx, guildId, userIds);
  if (!r) return out;
  const { guild, members } = r;
  const everyonePerms = guild.rolePerms[guildId] ?? DEFAULT_EVERYONE;
  const now = Date.now();
  for (const [uid, m] of members) {
    if (!m) continue;
    const ids = m.roleIds.filter((id) => guild.rolePerms[id] !== undefined);
    out.set(uid, {
      guildId, userId: uid, ownerId: guild.ownerId, isOwner: guild.ownerId === uid, everyoneId: guildId, everyonePerms,
      rolePerms: guild.rolePerms, rolePos: guild.rolePos, memberRoleIds: ids, timedOut: m.timeoutMs !== null && m.timeoutMs > now,
      topPosition: ids.reduce((a, id) => Math.max(a, guild.rolePos[id] ?? 0), 0),
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
export const loadOverwrites = (ctx: Ctx, channelId: string): Promise<Overwrite[]> => ctx.pcache.channelOverwrites(ctx, channelId);

export const DM_PERMS = Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY | Perm.ADD_REACTIONS | Perm.ATTACH_FILES |
  Perm.EMBED_LINKS | Perm.USE_EXTERNAL_EMOJIS | Perm.CONNECT | Perm.SPEAK | Perm.STREAM | Perm.USE_VAD;

export async function getChannelRow(ctx: Ctx, id: string) {
  return (await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]))[0] ?? null;
}

/** Cached topology-only channel row (id, guild_id, type, parent_id): safe for permission/fan-out decisions, not for display. */
export const getChannelLite = (ctx: Ctx, id: string) => ctx.pcache.channel(ctx, id);

/**
 * Permission check for hot paths (typing): zero DB queries once warm. Returns null when the channel is missing, the user is not a
 * member/participant, or the channel is not viewable (callers treat null as "not found").
 */
export async function channelPermsLite(ctx: Ctx, userId: string, channelId: string): Promise<{ channel: ChannelLite; perms: bigint } | null> {
  const channel = await getChannelLite(ctx, channelId);
  if (!channel) return null;
  if (!channel.guild_id) return (await ctx.pcache.dmParticipants(ctx, channelId)).has(userId) ? { channel, perms: DM_PERMS } : null;
  const gp = await loadGuildPerm(ctx, channel.guild_id, userId);
  if (!gp) return null;
  const permChannelId = channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id;
  const perms = permsFor(gp, await loadOverwrites(ctx, permChannelId));
  return has(perms, Perm.VIEW_CHANNEL) ? { channel, perms } : null;
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
    const parts = await ctx.pcache.dmParticipants(ctx, channel.id);
    return candidates.filter((u) => parts.has(u));
  }
  const permChannelId = channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id;
  const ow = await loadOverwrites(ctx, permChannelId);
  const gps = await loadGuildPerms(ctx, channel.guild_id, candidates);
  return [...gps.values()].filter((gp) => has(permsFor(gp, ow), Perm.VIEW_CHANNEL)).map((g) => g.userId);
}
export { ALL_PERMS, Perm, has };
