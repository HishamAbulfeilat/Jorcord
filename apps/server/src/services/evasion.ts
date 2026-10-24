import { EVASION_MIN_SCORE, EVASION_WINDOW_DAYS, evasionScore, evasionSignals, snowflake, type EvasionHint } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { audit } from './guilds';
import { loadModSettings } from './modSettings';
import { usersByIds } from './serializers';
import { notifyModerators } from './reports';

/**
 * Ban-evasion hint for a member who just joined: compared with the server's recent bans using only what the accounts themselves show
 * (name, avatar, account age, invite code). NO IP address and NO device fingerprint is collected or compared. A hint is a prompt for a human,
 * never an automatic action. Off unless the server enabled it.
 */
export async function checkBanEvasion(ctx: Ctx, guildId: string, userId: string): Promise<EvasionHint[]> {
  const s = await loadModSettings(ctx, guildId);
  if (!s.evasion.enabled) return [];
  const [u] = await ctx.db.query('SELECT username, display_name, avatar, created_at, bot FROM users WHERE id = $1', [userId]);
  const [m] = await ctx.db.query('SELECT joined_via FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (!u || u.bot || !m) return [];
  const bans = await ctx.db.query(
    `SELECT b.user_id, b.created_at, b.joined_via, bu.username, bu.display_name, bu.avatar FROM bans b JOIN users bu ON bu.id = b.user_id
      WHERE b.guild_id = $1 AND b.user_id <> $2 AND b.created_at > now() - ($3::int * interval '1 day') ORDER BY b.created_at DESC LIMIT 300`, [guildId, userId, EVASION_WINDOW_DAYS]);
  const made: EvasionHint[] = [];
  for (const b of bans) {
    const signals = evasionSignals(
      { username: u.username, displayName: u.display_name, avatar: u.avatar, createdAt: u.created_at, joinedVia: m.joined_via },
      { username: b.username, displayName: b.display_name, avatar: b.avatar, bannedAt: b.created_at, joinedVia: b.joined_via });
    const score = evasionScore(signals);
    if (score < EVASION_MIN_SCORE) continue;
    const rows = await ctx.db.query(
      `INSERT INTO evasion_hints (id, guild_id, user_id, banned_user_id, score, signals) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (guild_id, user_id, banned_user_id) DO NOTHING RETURNING *`,
      [snowflake(), guildId, userId, b.user_id, score, JSON.stringify(signals)]);
    if (rows.length) made.push(hintDTO(rows[0]));
  }
  if (made.length) {
    await audit(ctx, guildId, userId, 'EVASION_HINT_CREATED', userId, { bannedUserIds: made.map((h) => h.bannedUserId), score: Math.max(...made.map((h) => h.score)) });
    await ctx.hub.toGuild(guildId, 'GUILD_REPORTS_UPDATE', { guildId }); // the mod queue refreshes
    await notifyModerators(ctx, guildId, null, made.length);
  }
  return made;
}

export const hintDTO = (r: any): EvasionHint => ({
  id: r.id, guildId: r.guild_id, userId: r.user_id, bannedUserId: r.banned_user_id, score: r.score, signals: r.signals ?? [], status: r.status,
  createdAt: iso(r.created_at)!, handledBy: r.handled_by ?? null, handledAt: r.handled_at ? iso(r.handled_at)! : null,
});

export async function hintsWithUsers(ctx: Ctx, rows: any[]) {
  const users = await usersByIds(ctx, [...new Set(rows.flatMap((r) => [r.user_id as string, r.banned_user_id as string]))]);
  return rows.map((r) => ({ ...hintDTO(r), user: users.get(r.user_id) ?? null, bannedUser: users.get(r.banned_user_id) ?? null }));
}
