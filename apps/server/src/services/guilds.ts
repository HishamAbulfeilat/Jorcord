import { AuditActionType, DEFAULT_EVERYONE, Perm, has, snowflake, type Overwrite, type GuildFull } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import type { Queryable } from '../db';
import { badRequest, notFound } from '../errors';
import { channelsDTO, GUILD_SELECT, guildDTO, membersDTO, roleDTO } from './serializers';
import { deleteAttachmentFiles } from './files';
import { loadGuildPerm, permsFor } from './perms';

export async function audit(ctx: Ctx, guildId: string, actorId: string, action: string, targetId: string | null = null, changes: unknown = null, reason: string | null = null) {
  const actionType = (AuditActionType as Record<string, number>)[action] ?? null; // numeric taxonomy; the string `action` stays the primary key for clients
  await ctx.db.query('INSERT INTO audit_log (id, guild_id, actor_id, action, target_id, changes, reason, action_type) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
    [snowflake(), guildId, actorId, action, targetId, changes === null ? null : JSON.stringify(changes), reason, actionType]);
}

type TemplateChannel = { name: string; type: 'text' | 'voice' | 'announcement' | 'stage' | 'forum' };
export const GUILD_TEMPLATES: Record<string, { name: string; channels: TemplateChannel[] }[]> = {
  default: [
    { name: 'Text Channels', channels: [{ name: 'general', type: 'text' }] },
    { name: 'Voice Channels', channels: [{ name: 'General', type: 'voice' }] },
  ],
  gaming: [
    { name: 'Text Channels', channels: [{ name: 'general', type: 'text' }, { name: 'clips', type: 'text' }, { name: 'looking-for-group', type: 'text' }] },
    { name: 'Voice Channels', channels: [{ name: 'Lobby', type: 'voice' }, { name: 'Squad 1', type: 'voice' }, { name: 'Squad 2', type: 'voice' }] },
  ],
  study: [
    { name: 'Text Channels', channels: [{ name: 'general', type: 'text' }, { name: 'homework-help', type: 'text' }, { name: 'resources', type: 'text' }] },
    { name: 'Voice Channels', channels: [{ name: 'Study Room', type: 'voice' }, { name: 'Break Room', type: 'voice' }] },
  ],
  community: [
    { name: 'Info', channels: [{ name: 'announcements', type: 'announcement' }, { name: 'rules', type: 'text' }] },
    { name: 'Text Channels', channels: [{ name: 'general', type: 'text' }, { name: 'introductions', type: 'text' }, { name: 'discussions', type: 'forum' }] },
    { name: 'Voice Channels', channels: [{ name: 'Lounge', type: 'voice' }, { name: 'Events', type: 'stage' }] },
  ],
};

export async function insertChannel(q: Queryable, c: { id?: string; guildId: string | null; type: string; name: string | null; topic?: string | null; position?: number; parentId?: string | null; nsfw?: boolean; slowmode?: number; bitrate?: number | null; userLimit?: number | null; ownerId?: string | null; isClipsChannel?: boolean }) {
  const id = c.id ?? snowflake();
  await q.query(
    `INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, nsfw, slowmode, bitrate, user_limit, owner_id, is_clips_channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, c.guildId, c.type, c.name, c.topic ?? null, c.position ?? 0, c.parentId ?? null, c.nsfw ?? false, c.slowmode ?? 0,
      c.bitrate ?? (c.type === 'voice' || c.type === 'stage' ? 64000 : null), c.userLimit ?? null, c.ownerId ?? null, c.isClipsChannel ?? false]);
  return id;
}

export async function createGuild(ctx: Ctx, ownerId: string, input: { name: string; icon?: string | null; template?: string }): Promise<string> {
  const id = snowflake();
  const tpl = GUILD_TEMPLATES[input.template ?? 'default'] ?? GUILD_TEMPLATES.default!;
  await ctx.db.tx(async (q) => {
    await q.query('INSERT INTO guilds (id, name, icon, owner_id) VALUES ($1,$2,$3,$4)', [id, input.name, input.icon ?? null, ownerId]);
    await q.query(`INSERT INTO roles (id, guild_id, name, permissions, position) VALUES ($1,$1,'@everyone',$2,0)`, [id, DEFAULT_EVERYONE.toString()]);
    await q.query('INSERT INTO members (guild_id, user_id) VALUES ($1,$2)', [id, ownerId]);
    let pos = 0, firstText: string | null = null;
    for (const cat of tpl) {
      const catId = await insertChannel(q, { guildId: id, type: 'category', name: cat.name, position: pos++ });
      for (const ch of cat.channels) {
        const cid = await insertChannel(q, { guildId: id, type: ch.type, name: ch.name, parentId: catId, position: pos++ });
        if (!firstText && ch.type === 'text') firstText = cid;
      }
    }
    await q.query('UPDATE guilds SET system_channel_id = $2 WHERE id = $1', [id, firstText]);
  });
  return id;
}

export async function visibleChannelRows(ctx: Ctx, guildId: string, userId: string, alsoNeed: bigint = 0n): Promise<any[]> {
  const gp = await loadGuildPerm(ctx, guildId, userId);
  if (!gp) return [];
  const rows = await ctx.db.query('SELECT * FROM channels WHERE guild_id = $1 AND NOT (type = \'thread\' AND archived) ORDER BY position, id', [guildId]);
  const ows = await ctx.db.query('SELECT o.* FROM overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = $1', [guildId]);
  const byCh = new Map<string, Overwrite[]>();
  for (const o of ows) { const l = byCh.get(o.channel_id) ?? []; l.push({ id: o.target_id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }); byCh.set(o.channel_id, l); }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const canView = (r: any) => { const src = r.type === 'thread' && r.parent_id ? byId.get(r.parent_id) ?? r : r; const p = permsFor(gp, byCh.get(src.id) ?? []); return has(p, Perm.VIEW_CHANNEL) && has(p, alsoNeed); };
  const seen = rows.filter(canView);
  // private threads: members, owners and MANAGE_THREADS holders only
  const priv = seen.filter((r) => r.type === 'thread' && r.thread_private);
  if (!priv.length) return seen;
  const mine = new Set((await ctx.db.query('SELECT thread_id FROM thread_members WHERE user_id = $1 AND thread_id = ANY($2::text[])', [userId, priv.map((r) => r.id)])).map((r) => r.thread_id as string));
  const canManage = (r: any) => { const src = byId.get(r.parent_id) ?? r; return has(permsFor(gp, byCh.get(src.id) ?? []), Perm.MANAGE_THREADS); };
  return seen.filter((r) => !(r.type === 'thread' && r.thread_private) || mine.has(r.id) || r.owner_id === userId || canManage(r));
}

export async function buildGuildFull(ctx: Ctx, guildId: string, userId: string): Promise<GuildFull> {
  const [g] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [guildId]);
  if (!g) throw notFound('Guild');
  const [channelRows, roles, memberRows, emojis, stickers, [cnt]] = await Promise.all([
    visibleChannelRows(ctx, guildId, userId),
    ctx.db.query('SELECT * FROM roles WHERE guild_id = $1 ORDER BY position DESC, id', [guildId]),
    ctx.db.query('SELECT * FROM members WHERE guild_id = $1 ORDER BY (user_id = $2) DESC, joined_at LIMIT 1000', [guildId, userId]),
    ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1', [guildId]),
    ctx.db.query('SELECT * FROM stickers WHERE guild_id = $1', [guildId]),
    ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [guildId]),
  ]);
  return {
    ...guildDTO(g),
    channels: await channelsDTO(ctx, channelRows), roles: roles.map(roleDTO), members: await membersDTO(ctx, memberRows),
    emojis: emojis.map((e) => ({ id: e.id, guildId: e.guild_id, name: e.name, animated: e.animated, url: e.url, ...(e.role_ids?.length ? { roleIds: e.role_ids as string[] } : {}) })),
    stickers: stickers.map((s) => ({ id: s.id, guildId: s.guild_id, name: s.name, url: s.url, format: s.format })),
    memberCount: cnt.n,
  };
}

/** Deletes a server with everything in it (messages, attachments) and tells its members. Shared by the owner's DELETE and by account deletion. */
export async function deleteGuildCascade(ctx: Ctx, id: string) {
  const members = (await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [id])).map((r) => r.user_id as string);
  await ctx.db.query(`UPDATE users SET server_tag = NULL WHERE server_tag->>'guildId' = $1`, [id]);
  const attachmentLists = (await ctx.db.query(`SELECT attachments FROM messages WHERE guild_id = $1 AND attachments <> '[]'::jsonb`, [id])).map((r) => r.attachments);
  await ctx.db.tx(async (q) => {
    await q.query('DELETE FROM messages WHERE guild_id = $1', [id]);
    await q.query('DELETE FROM guilds WHERE id = $1', [id]);
  });
  await deleteAttachmentFiles(ctx, attachmentLists).catch((e) => ctx.log.warn({ err: e }, 'attachment cleanup failed'));
  await ctx.pcache.invalidate({ k: 'guild', guildId: id });
  await ctx.hub.toUsers(members, 'GUILD_DELETE', { id });
}

/** Hands a server to another human member. The previous owner stays a normal member. Callers authorise (owner + re-authentication). */
export async function transferGuildOwnership(ctx: Ctx, guildId: string, newOwnerId: string, byUserId: string) {
  const [m] = await ctx.db.query('SELECT 1 AS x FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id = $2 AND NOT u.bot AND u.deleted_at IS NULL', [guildId, newOwnerId]);
  if (!m) throw badRequest('The new owner must be a (non-bot) member of the server');
  await ctx.db.query('UPDATE guilds SET owner_id = $2 WHERE id = $1', [guildId, newOwnerId]);
  await ctx.pcache.invalidate({ k: 'guild', guildId });
  await audit(ctx, guildId, byUserId, 'GUILD_UPDATE', guildId, { ownerId: newOwnerId });
  const [row] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [guildId]);
  if (row) await ctx.hub.toGuild(guildId, 'GUILD_UPDATE', guildDTO(row));
}
