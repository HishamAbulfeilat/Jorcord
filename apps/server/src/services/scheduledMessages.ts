import { LIMITS, Perm, has, snowflakeTime, type ScheduledMessage } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden } from '../errors';
import { iso } from '../lib/ids';
import { createMessage } from './messages';
import { channelAccess, need } from './perms';
import { ageGate } from './agegate';

type Access = Awaited<ReturnType<typeof channelAccess>>;

export function scheduledDTO(r: any): ScheduledMessage {
  return {
    id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null, content: r.content, replyTo: r.reply_to ?? null, sendAt: iso(r.send_at)!, status: r.status,
    error: r.error ?? null, sentMessageId: r.sent_message_id ?? null, createdAt: iso(r.created_at)!,
  };
}

/**
 * The same posting rules as POST /channels/:id/messages (channel type, SEND_MESSAGES / SEND_IN_THREADS, locked threads, DM blocks), re-run when the
 * message is due so permissions revoked in the meantime are honoured. `slowmode` is only checked at send time: scheduling is not a way around it.
 * Keep in step with `assertCanPostIn` in routes/messages.ts.
 */
export async function assertCanPost(ctx: Ctx, a: Access, userId: string, opts: { slowmode: boolean }) {
  const t = a.channel.type;
  if (t === 'category' || t === 'forum' || t === 'media') throw badRequest('Cannot send messages in this channel type');
  need(a.perms, t === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES);
  if (a.gp?.timedOut) throw forbidden('You cannot send messages while timed out or before accepting the server rules');
  if (t === 'thread' && a.channel.locked && !has(a.perms, Perm.MANAGE_THREADS)) throw new ApiError(403, 'THREAD_LOCKED', 'This thread is locked').num(50083);
  if (t === 'dm') {
    const [blk] = await ctx.db.query(
      `SELECT 1 AS x FROM relationships r JOIN dm_participants p ON p.channel_id = $1 WHERE r.type = 'blocked' AND ((r.user_id = $2 AND r.other_id = p.user_id) OR (r.other_id = $2 AND r.user_id = p.user_id)) LIMIT 1`, [a.channel.id, userId]);
    if (blk) throw forbidden('You cannot message this user', 'BLOCKED');
  }
  if (opts.slowmode && a.channel.slowmode > 0 && !has(a.perms, Perm.MANAGE_MESSAGES) && !has(a.perms, Perm.MANAGE_CHANNELS)) {
    const [last] = await ctx.db.query("SELECT max(id) AS id FROM messages WHERE channel_id = $1 AND author_id = $2 AND type IN ('default','reply')", [a.channel.id, userId]);
    if (last?.id) {
      const wait = Math.ceil((snowflakeTime(last.id) + a.channel.slowmode * 1000 - Date.now()) / 1000);
      if (wait > 0) throw new ApiError(429, 'SLOWMODE', `Slowmode: wait ${wait}s`, { retryAfter: wait });
    }
  }
}

export const validContent = (content: string) => {
  if (!content.trim()) throw badRequest('A scheduled message needs content');
  if (content.length > LIMITS.maxMessageLength) throw badRequest(`Message exceeds ${LIMITS.maxMessageLength} characters`);
};

/** Tell the author's sessions about a status change. */
async function notify(ctx: Ctx, row: any) { await ctx.hub.toUser(row.author_id, 'SCHEDULED_MESSAGE_UPDATE', scheduledDTO(row)).catch(() => {}); }

/** Send one claimed (status = 'sending') row as its author. Never throws: failures are recorded on the row. */
async function deliver(ctx: Ctx, row: any) {
  let status: 'sent' | 'failed' = 'failed'; let error: string | null = null; let sentId: string | null = null;
  try {
    const a = await channelAccess(ctx, row.author_id, row.channel_id); // gone channel / left server -> 404
    await ageGate(ctx, row.author_id, false, a);
    await assertCanPost(ctx, a, row.author_id, { slowmode: true });
    const msg = await createMessage(ctx, { channel: a.channel, authorId: row.author_id, content: row.content, replyTo: row.reply_to ?? undefined, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds });
    status = 'sent'; sentId = msg.id;
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  const [done] = await ctx.db.query('UPDATE scheduled_messages SET status = $2, error = $3, sent_message_id = $4, finished_at = now() WHERE id = $1 RETURNING *', [row.id, status, error, sentId]);
  if (done) await notify(ctx, done);
}

/** Sweeper step: claim due rows atomically (several nodes may sweep at once) and send them. Returns how many were handled. */
export async function sendDueScheduledMessages(ctx: Ctx) {
  const rows = await ctx.db.query(
    `UPDATE scheduled_messages SET status = 'sending' WHERE id IN (SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= now() ORDER BY send_at LIMIT 50) AND status = 'pending' RETURNING *`);
  for (const r of rows) await deliver(ctx, r);
  // a node that died mid-send leaves 'sending' behind: after 10 minutes call it failed rather than retry (it may have been posted)
  const stuck = await ctx.db.query(`UPDATE scheduled_messages SET status = 'failed', error = 'Interrupted while sending', finished_at = now() WHERE status = 'sending' AND send_at < now() - interval '10 minutes' RETURNING *`);
  for (const r of stuck) await notify(ctx, r);
  // history older than a week goes away
  await ctx.db.query(`DELETE FROM scheduled_messages WHERE status IN ('sent','failed','canceled') AND finished_at < now() - interval '7 days'`);
  return rows.length;
}
