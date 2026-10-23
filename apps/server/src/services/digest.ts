import { LARGE_SERVER_MEMBER_THRESHOLD, snowflake, type DigestEntry, type DigestFrequency, type DigestItem, type DigestPrefs } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';

/**
 * Notification digest ("quiet mode"). A server or channel flagged `digest` in notification_settings does not ping: no mention badge and no push.
 * What would have pinged is remembered as ids in digest_pending and, once the user's period (hourly / daily) has passed since the oldest held item,
 * turned into ONE Inbox entry (digest_entries) listing how much piled up per channel. No message text is copied.
 */
export const PERIOD_MS: Record<DigestFrequency, number> = { hourly: 3_600_000, daily: 86_400_000 };
const MAX_ENTRIES_KEPT = 100;
const PENDING_MAX_AGE = '7 days';
const ENTRY_MAX_AGE = '30 days';

export const DEFAULT_PREFS: DigestPrefs = { frequency: 'daily', largeServerMentionsOnly: true, largeServerThreshold: LARGE_SERVER_MEMBER_THRESHOLD };

export async function getPrefs(ctx: Ctx, userId: string): Promise<DigestPrefs> {
  const [r] = await ctx.db.query('SELECT frequency, large_server_mentions_only FROM notification_digest_prefs WHERE user_id = $1', [userId]);
  return r ? { frequency: r.frequency as DigestFrequency, largeServerMentionsOnly: !!r.large_server_mentions_only, largeServerThreshold: LARGE_SERVER_MEMBER_THRESHOLD } : { ...DEFAULT_PREFS };
}

export const entryDTO = (r: any): DigestEntry => ({ id: r.id, periodStart: iso(r.period_start)!, periodEnd: iso(r.period_end)!, total: r.total, items: (r.items ?? []) as DigestItem[], readAt: iso(r.read_at), createdAt: iso(r.created_at)! });

/** Which of `userIds` hold this channel (or its server, or a thread's parent channel) in digest mode. */
export async function digestHolders(ctx: Ctx, channel: { id: string; guild_id?: string | null; parent_id?: string | null; type?: string }, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const channelIds = [channel.id, ...(channel.type === 'thread' && channel.parent_id ? [channel.parent_id] : [])];
  const rows = await ctx.db.query(
    `SELECT DISTINCT user_id FROM notification_settings WHERE digest AND user_id = ANY($1::text[]) AND ((scope = 'guild' AND target_id = $2) OR (scope = 'channel' AND target_id = ANY($3::text[])))`,
    [userIds, channel.guild_id ?? '', channelIds]);
  return new Set(rows.map((r) => r.user_id as string));
}

/** Remember one held-back notification per user. `direct` = they were @mentioned by name or it was a DM (vs a role / @everyone ping). */
export async function holdForDigest(ctx: Ctx, channel: { id: string; guild_id?: string | null }, messageId: string, userIds: string[], direct: Set<string>) {
  if (!userIds.length) return;
  await ctx.db.query(
    `INSERT INTO digest_pending (id, user_id, guild_id, channel_id, message_id, mention) SELECT i, u, $3, $4, $5, m FROM unnest($1::text[], $2::text[], $6::boolean[]) AS t(i, u, m) ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userIds.map(() => snowflake()), userIds, channel.guild_id ?? null, channel.id, messageId, userIds.map((u) => direct.has(u))]);
}

/**
 * Turns every user's due pending items into one Inbox entry. Atomic per user (DELETE ... RETURNING), so several server nodes never produce two digests
 * for the same items. Items for servers / DMs the user has since left are dropped. Returns how many entries were made.
 */
export async function sendDueDigests(ctx: Ctx, now = new Date()): Promise<number> {
  const due = await ctx.db.query(
    `SELECT p.user_id FROM digest_pending p LEFT JOIN notification_digest_prefs pr ON pr.user_id = p.user_id
      GROUP BY p.user_id, pr.frequency
     HAVING min(p.created_at) <= $1::timestamptz - (CASE WHEN coalesce(pr.frequency, 'daily') = 'hourly' THEN interval '1 hour' ELSE interval '1 day' END) LIMIT 200`, [now]);
  let made = 0;
  for (const u of due) {
    const rows = await ctx.db.query('DELETE FROM digest_pending WHERE user_id = $1 AND created_at <= $2::timestamptz RETURNING guild_id, channel_id, message_id, mention, created_at', [u.user_id, now]);
    if (!rows.length) continue;
    const gids = [...new Set(rows.map((r) => r.guild_id).filter(Boolean))] as string[];
    const cids = [...new Set(rows.filter((r) => !r.guild_id).map((r) => r.channel_id))] as string[];
    const inG = new Set((gids.length ? await ctx.db.query('SELECT guild_id FROM members WHERE user_id = $1 AND guild_id = ANY($2::text[])', [u.user_id, gids]) : []).map((r) => r.guild_id as string));
    const inD = new Set((cids.length ? await ctx.db.query('SELECT channel_id FROM dm_participants WHERE user_id = $1 AND channel_id = ANY($2::text[])', [u.user_id, cids]) : []).map((r) => r.channel_id as string));
    const byCh = new Map<string, DigestItem>();
    for (const r of rows) {
      if (r.guild_id ? !inG.has(r.guild_id) : !inD.has(r.channel_id)) continue;
      const it = byCh.get(r.channel_id) ?? { guildId: r.guild_id ?? null, channelId: r.channel_id as string, count: 0, mentions: 0, lastMessageId: r.message_id as string };
      it.count++; if (r.mention) it.mentions++; if (BigInt(r.message_id) > BigInt(it.lastMessageId)) it.lastMessageId = r.message_id;
      byCh.set(r.channel_id, it);
    }
    if (!byCh.size) continue;
    const items = [...byCh.values()].sort((a, b) => b.mentions - a.mentions || b.count - a.count).slice(0, 100);
    const total = items.reduce((n, i) => n + i.count, 0);
    const start = rows.reduce((m, r) => (new Date(r.created_at) < m ? new Date(r.created_at) : m), new Date(rows[0]!.created_at));
    const id = snowflake();
    const [e] = await ctx.db.query('INSERT INTO digest_entries (id, user_id, period_start, period_end, total, items) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *', [id, u.user_id, start, now, total, JSON.stringify(items)]);
    await ctx.hub.toUser(u.user_id, 'DIGEST_CREATE', entryDTO(e)).catch(() => {});
    made++;
  }
  // housekeeping: stale held items (the user never came back to a flagged scope for a week) and old / excess entries
  await ctx.db.query(`DELETE FROM digest_pending WHERE created_at < now() - interval '${PENDING_MAX_AGE}'`);
  await ctx.db.query(`DELETE FROM digest_entries WHERE created_at < now() - interval '${ENTRY_MAX_AGE}'`);
  await ctx.db.query(`DELETE FROM digest_entries WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY id DESC) AS rn FROM digest_entries) x WHERE rn > ${MAX_ENTRIES_KEPT})`);
  return made;
}

/**
 * Joining a server with more than `threshold` members: if the user has no choice for it yet and the server would otherwise ping for every message,
 * default them to mentions-only. Never overrides an existing choice and never touches users who switched the default off.
 */
export async function applyLargeServerDefault(ctx: Ctx, userId: string, guildId: string, threshold = LARGE_SERVER_MEMBER_THRESHOLD): Promise<boolean> {
  const prefs = await getPrefs(ctx, userId);
  if (!prefs.largeServerMentionsOnly) return false;
  const [g] = await ctx.db.query('SELECT default_notifications FROM guilds WHERE id = $1', [guildId]);
  if (!g || g.default_notifications !== 'all') return false; // already quiet by default
  const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [guildId]);
  if (n.n <= threshold) return false;
  const r = await ctx.db.query(`INSERT INTO notification_settings (user_id, scope, target_id, level) VALUES ($1,'guild',$2,'mentions') ON CONFLICT (user_id, scope, target_id) DO NOTHING RETURNING user_id`, [userId, guildId]);
  return r.length > 0;
}
