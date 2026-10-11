import { BOOST_LEVELS, BOOST_THRESHOLDS, boostLevelFor, boostPerks, snowflake, type BoostSummary } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { postSystemMessage } from './messages';
import { applyRoleChanges } from './roles';
import { GUILD_SELECT, guildDTO, roleDTO, usersByIds } from './serializers';

export const BOOSTER_ROLE_NAME = 'Server Booster';
export const MAX_BOOSTS_PER_REQUEST = 10;

/** Emoji / sticker slots of a server, from its boost level (the only perks Jorcord enforces). */
export async function slotLimits(ctx: Ctx, guildId: string): Promise<{ level: number; emojiSlots: number; stickerSlots: number }> {
  const [r] = await ctx.db.query('SELECT count(*)::int AS n FROM boosts WHERE guild_id = $1', [guildId]);
  const level = boostLevelFor(r?.n ?? 0), p = boostPerks(level);
  return { level, emojiSlots: p.emojiSlots, stickerSlots: p.stickerSlots };
}

export async function boostSummary(ctx: Ctx, guildId: string, viewerId: string): Promise<BoostSummary> {
  const [g] = await ctx.db.query('SELECT booster_role_id, boost_announce, booster_role_enabled FROM guilds WHERE id = $1', [guildId]);
  const rows = await ctx.db.query('SELECT user_id, count(*)::int AS n, min(created_at) AS since FROM boosts WHERE guild_id = $1 GROUP BY user_id ORDER BY min(created_at) LIMIT 200', [guildId]);
  const [tot] = await ctx.db.query('SELECT count(*)::int AS n FROM boosts WHERE guild_id = $1', [guildId]);
  const count = tot?.n ?? 0, level = boostLevelFor(count);
  const users = await usersByIds(ctx, rows.map((r) => r.user_id));
  const next = level < 3 ? BOOST_LEVELS[level + 1]! : null;
  return {
    guildId, count, level, perks: boostPerks(level), nextLevel: next, boostsToNext: next ? next.boosts - count : null, myBoosts: rows.find((r) => r.user_id === viewerId)?.n ?? 0,
    boosters: rows.filter((r) => users.has(r.user_id)).map((r) => ({ user: users.get(r.user_id)!, boosts: r.n, since: iso(r.since)! })),
    settings: { announce: g?.boost_announce ?? true, boosterRole: g?.booster_role_enabled ?? true, boosterRoleId: g?.booster_role_id ?? null },
  };
}

/** The server's booster role, created on first use (hoisted, pink, no permissions). Null when the feature is switched off. */
export async function ensureBoosterRole(ctx: Ctx, guildId: string): Promise<string | null> {
  const [g] = await ctx.db.query('SELECT booster_role_id, booster_role_enabled FROM guilds WHERE id = $1', [guildId]);
  if (!g || !g.booster_role_enabled) return null;
  if (g.booster_role_id) { const [r] = await ctx.db.query('SELECT id FROM roles WHERE id = $1 AND guild_id = $2', [g.booster_role_id, guildId]); if (r) return r.id; }
  const id = snowflake();
  await ctx.db.query(`INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable, managed_kind) VALUES ($1,$2,$3,$4,true,1,'0',false,'booster')`, [id, guildId, BOOSTER_ROLE_NAME, 0xf47fff]);
  await ctx.db.query('UPDATE guilds SET booster_role_id = $2 WHERE id = $1', [guildId, id]);
  const [row] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [id]);
  await ctx.hub.toGuild(guildId, 'ROLE_CREATE', roleDTO(row));
  return id;
}

async function pushGuild(ctx: Ctx, guildId: string) {
  const [g] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [guildId]);
  if (g) await ctx.hub.toGuild(guildId, 'GUILD_UPDATE', guildDTO(g));
}

/** Adds `n` boosts from a member: booster role, GUILD_UPDATE, and an announcement in the system channel (with "level reached" when it levelled up). */
export async function addBoosts(ctx: Ctx, guildId: string, userId: string, n = 1) {
  const [before] = await ctx.db.query('SELECT count(*)::int AS n FROM boosts WHERE guild_id = $1', [guildId]);
  for (let i = 0; i < n; i++) await ctx.db.query('INSERT INTO boosts (id, guild_id, user_id) VALUES ($1,$2,$3)', [snowflake(), guildId, userId]);
  const lvlBefore = boostLevelFor(before?.n ?? 0), lvlAfter = boostLevelFor((before?.n ?? 0) + n);
  const role = await ensureBoosterRole(ctx, guildId);
  if (role) await applyRoleChanges(ctx, guildId, userId, [role], []);
  await pushGuild(ctx, guildId);
  const [g] = await ctx.db.query('SELECT system_channel_id, boost_announce FROM guilds WHERE id = $1', [guildId]);
  if (g?.system_channel_id && g.boost_announce) await postSystemMessage(ctx, g.system_channel_id, userId, 'boost', lvlAfter > lvlBefore ? `level:${lvlAfter}` : n > 1 ? `x${n}` : '').catch((e) => ctx.log.warn({ err: e }, 'boost announcement failed'));
  return { levelUp: lvlAfter > lvlBefore, level: lvlAfter };
}

/** Takes back one of the member's boosts (the newest). Their booster role goes with their last boost. Returns false when they had none. */
export async function removeBoost(ctx: Ctx, guildId: string, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('DELETE FROM boosts WHERE id = (SELECT id FROM boosts WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1) RETURNING id', [guildId, userId]);
  if (!rows.length) return false;
  const [left] = await ctx.db.query('SELECT count(*)::int AS n FROM boosts WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (!left.n) { const [g] = await ctx.db.query('SELECT booster_role_id FROM guilds WHERE id = $1', [guildId]); if (g?.booster_role_id) await applyRoleChanges(ctx, guildId, userId, [], [g.booster_role_id]); }
  await pushGuild(ctx, guildId);
  return true;
}

/** Re-applies the booster role setting: creates the role and hands it to every booster, or deletes it. */
export async function syncBoosterRole(ctx: Ctx, guildId: string) {
  const [g] = await ctx.db.query('SELECT booster_role_id, booster_role_enabled FROM guilds WHERE id = $1', [guildId]);
  if (!g) return;
  if (!g.booster_role_enabled) {
    if (g.booster_role_id) {
      const holders = (await ctx.db.query('SELECT user_id FROM member_roles WHERE role_id = $1', [g.booster_role_id])).map((r) => r.user_id as string);
      for (const u of holders) await applyRoleChanges(ctx, guildId, u, [], [g.booster_role_id]);
      await ctx.db.query('DELETE FROM roles WHERE id = $1', [g.booster_role_id]);
      await ctx.db.query('UPDATE guilds SET booster_role_id = NULL WHERE id = $1', [guildId]);
      await ctx.hub.toGuild(guildId, 'ROLE_DELETE', { id: g.booster_role_id, guildId });
    }
    return;
  }
  const boosters = (await ctx.db.query('SELECT DISTINCT user_id FROM boosts WHERE guild_id = $1', [guildId])).map((r) => r.user_id as string);
  if (!boosters.length) return;
  const role = await ensureBoosterRole(ctx, guildId);
  if (role) for (const u of boosters) { const [m] = await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, u]); if (m) await applyRoleChanges(ctx, guildId, u, [role], []); }
}

export { BOOST_THRESHOLDS };
