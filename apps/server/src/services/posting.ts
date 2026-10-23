import { Perm, has, snowflakeTime } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden } from '../errors';
import { channelAccess, need } from './perms';

type Access = Awaited<ReturnType<typeof channelAccess>>;

/**
 * The single source of truth for "may this user post a message here right now": channel type, SEND_MESSAGES / SEND_IN_THREADS, locked threads,
 * timeouts / pending rules, DM blocks and (unless `slowmode: false`, used when only scheduling) slowmode.
 * Used by POST /channels/:id/messages and by scheduled messages (at schedule time and again when due).
 */
export async function assertCanPostIn(ctx: Ctx, a: Access, userId: string, opts: { slowmode?: boolean } = {}) {
  const t = a.channel.type;
  if (t === 'category' || t === 'forum' || t === 'media') throw badRequest('Cannot send messages in this channel type');
  // Voice and stage channels carry a text chat: they take messages under the same SEND_MESSAGES rules (overwrites included).
  need(a.perms, t === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES);
  if (a.gp?.timedOut) throw forbidden('You cannot send messages while timed out or before accepting the server rules');
  if (t === 'thread' && a.channel.locked && !has(a.perms, Perm.MANAGE_THREADS)) throw new ApiError(403, 'THREAD_LOCKED', 'This thread is locked').num(50083);
  if (t === 'dm') {
    const [blk] = await ctx.db.query(
      `SELECT 1 AS x FROM relationships r JOIN dm_participants p ON p.channel_id = $1 WHERE r.type = 'blocked' AND ((r.user_id = $2 AND r.other_id = p.user_id) OR (r.other_id = $2 AND r.user_id = p.user_id)) LIMIT 1`, [a.channel.id, userId]);
    if (blk) throw forbidden('You cannot message this user', 'BLOCKED');
  }
  if (opts.slowmode !== false && a.channel.slowmode > 0 && !has(a.perms, Perm.BYPASS_SLOWMODE)) {
    const [last] = await ctx.db.query("SELECT max(id) AS id FROM messages WHERE channel_id = $1 AND author_id = $2 AND type IN ('default','reply')", [a.channel.id, userId]);
    if (last?.id) {
      const wait = Math.ceil((snowflakeTime(last.id) + a.channel.slowmode * 1000 - Date.now()) / 1000);
      if (wait > 0) throw new ApiError(429, 'SLOWMODE', `Slowmode: wait ${wait}s`, { retryAfter: wait }, { 'retry-after': String(wait) });
    }
  }
}
