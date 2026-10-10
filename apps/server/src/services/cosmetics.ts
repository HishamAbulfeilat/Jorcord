import type { Ctx } from '../ctx';
import { badRequest } from '../errors';
import { userDTO } from './serializers';

const tagJson = (g: { id: string; tag: string; tag_badge: string | null }) => JSON.stringify({ guildId: g.id, tag: g.tag, badge: g.tag_badge ?? null });

/** Wear (or drop, with null) the tag of a server I am in. The server must have set one. */
export async function setServerTag(ctx: Ctx, userId: string, guildId: string | null) {
  if (guildId === null) { await ctx.db.query('UPDATE users SET server_tag = NULL WHERE id = $1', [userId]); return; }
  const [g] = await ctx.db.query('SELECT g.id, g.tag, g.tag_badge FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = $2 WHERE g.id = $1', [guildId, userId]);
  if (!g) throw badRequest('You are not in that server');
  if (!g.tag) throw badRequest('That server has no tag');
  await ctx.db.query('UPDATE users SET server_tag = $2::jsonb WHERE id = $1', [userId, tagJson(g)]);
}

/** A guild's tag/badge changed or was removed: refresh everyone wearing it and tell the guild. */
export async function syncGuildTag(ctx: Ctx, guildId: string) {
  const [g] = await ctx.db.query('SELECT id, tag, tag_badge FROM guilds WHERE id = $1', [guildId]);
  if (!g) return;
  const rows = g.tag
    ? await ctx.db.query(`UPDATE users SET server_tag = $2::jsonb WHERE server_tag->>'guildId' = $1 RETURNING *`, [guildId, tagJson(g)])
    : await ctx.db.query(`UPDATE users SET server_tag = NULL WHERE server_tag->>'guildId' = $1 RETURNING *`, [guildId]);
  for (const r of rows) await ctx.hub.toGuild(guildId, 'USER_UPDATE', userDTO(ctx, r));
}

/** Leaving, kicks, bans: stop wearing the tag of a server I am no longer in. */
export async function clearServerTag(ctx: Ctx, guildId: string, userId: string) {
  const rows = await ctx.db.query(`UPDATE users SET server_tag = NULL WHERE id = $2 AND server_tag->>'guildId' = $1 RETURNING *`, [guildId, userId]);
  for (const r of rows) await ctx.hub.toPresenceAudience(userId, 'USER_UPDATE', userDTO(ctx, r));
}
