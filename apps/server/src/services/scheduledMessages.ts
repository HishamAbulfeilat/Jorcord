import { LIMITS, Perm, type Attachment, type ScheduledMessage } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest } from '../errors';
import { iso } from '../lib/ids';
import { createMessage } from './messages';
import { channelAccess, need } from './perms';
import { ageGate } from './agegate';
import { assertCanPostIn } from './posting';
import { claimAttachments, deleteAttachmentFiles } from './files';

type Access = Awaited<ReturnType<typeof channelAccess>>;

export function scheduledDTO(r: any): ScheduledMessage {
  return {
    id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null, content: r.content, attachments: r.attachments ?? [], replyTo: r.reply_to ?? null, sendAt: iso(r.send_at)!, status: r.status,
    error: r.error ?? null, sentMessageId: r.sent_message_id ?? null, createdAt: iso(r.created_at)!,
  };
}

/** Content may be empty only when attachments carry the message. */
export const validContent = (content: string, attachmentCount = 0) => {
  if (!content.trim() && !attachmentCount) throw badRequest('A scheduled message needs content or an attachment');
  if (content.length > LIMITS.maxMessageLength) throw badRequest(`Message exceeds ${LIMITS.maxMessageLength} characters`);
};

/** The normal send rules for files, applied to ones already stored: ATTACH_FILES, and SEND_VOICE_MESSAGES for audio. */
export function assertCanAttach(a: Access, attachments: Attachment[]) {
  if (!attachments.length) return;
  need(a.perms, Perm.ATTACH_FILES);
  if (attachments.some((at) => at.contentType.startsWith('audio/'))) need(a.perms, Perm.SEND_VOICE_MESSAGES);
}

/** Schedule / edit time: claim the uploads (own and unattached: the same IDOR guard as a normal send) and check the attach permissions. */
export async function claimScheduledAttachments(ctx: Ctx, a: Access, userId: string, ids: string[]): Promise<Attachment[]> {
  if (!ids.length) return [];
  if (ids.length > 10) throw badRequest('At most 10 files per message');
  need(a.perms, Perm.ATTACH_FILES);
  const claimed = await claimAttachments(ctx, userId, ids);
  try { assertCanAttach(a, claimed); } catch (e) { await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [claimed.map((x) => x.id)]); throw e; }
  return claimed;
}

/** The files of a scheduled message that will never be sent: delete rows + stored objects. Best effort. */
export const releaseScheduledAttachments = (ctx: Ctx, list: unknown) => deleteAttachmentFiles(ctx, [list]).catch((e) => ctx.log.warn({ err: e }, 'scheduled attachment cleanup failed'));

/** Tell the author's sessions about a status change. */
export async function notify(ctx: Ctx, row: any) { await ctx.hub.toUser(row.author_id, 'SCHEDULED_MESSAGE_UPDATE', scheduledDTO(row)).catch(() => {}); }

/** Send one claimed (status = 'sending') row as its author. Never throws: failures are recorded on the row. */
async function deliver(ctx: Ctx, row: any) {
  let status: 'sent' | 'failed' = 'failed'; let error: string | null = null; let sentId: string | null = null;
  const attachments: Attachment[] = row.attachments ?? [];
  try {
    const a = await channelAccess(ctx, row.author_id, row.channel_id); // gone channel / left server -> 404
    await ageGate(ctx, row.author_id, false, a);
    await assertCanPostIn(ctx, a, row.author_id, { slowmode: true });
    assertCanAttach(a, attachments); // permissions may have been revoked since scheduling
    if (attachments.length) { // the claimed uploads must still be there and still the author's
      const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM files WHERE id = ANY($1::text[]) AND uploader_id = $2 AND attached', [attachments.map((x) => x.id), row.author_id]);
      if (n.n !== attachments.length) throw badRequest('An attachment is no longer available');
    }
    const msg = await createMessage(ctx, { channel: a.channel, authorId: row.author_id, content: row.content, replyTo: row.reply_to ?? undefined, attachments, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds });
    status = 'sent'; sentId = msg.id;
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  if (status === 'failed' && attachments.length) await releaseScheduledAttachments(ctx, attachments);
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
