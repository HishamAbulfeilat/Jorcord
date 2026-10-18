import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, Perm } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, forbidden, notFound } from '../errors';
import { idSchema, limitParam, parse } from '../lib/ids';
import { claimAttachments, deleteAttachmentFiles } from '../services/files';
import { createMessage } from '../services/messages';
import { channelAccess, need } from '../services/perms';
import { messagesDTO } from '../services/serializers';

/** A clip is a single video attachment no longer than 30 seconds. */
export const MAX_CLIP_SECONDS = 30;

const clipBody = z.object({
  /** The uploaded file id to post (exactly one video). */
  attachmentId: idSchema.optional(),
  attachments: z.array(idSchema).max(1).optional(),
  content: z.string().max(LIMITS.maxMessageLength).optional(),
  durationSeconds: z.coerce.number().positive().max(MAX_CLIP_SECONDS).optional(),
  duration: z.coerce.number().positive().max(MAX_CLIP_SECONDS).optional(),
}).strict();

const listQuery = z.object({ before: idSchema.optional(), limit: z.coerce.number().optional() });

/** Clips as messages + clip metadata (id/messageId are the message id). */
const clipDTO = (message: any, durationSeconds: number | null) => ({
  ...message, clipId: message.id, messageId: message.id, durationSeconds,
});

export function clipRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/channels/:id/clips', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(clipBody, req.body);
    const a = await channelAccess(ctx, req.userId, id);
    need(a.perms, a.channel.type === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES, Perm.ATTACH_FILES);
    const ids = [...(b.attachments ?? []), ...(b.attachmentId ? [b.attachmentId] : [])];
    if (ids.length !== 1) throw badRequest('Provide exactly one video attachment');
    const durationSeconds = b.durationSeconds ?? b.duration ?? null;
    const attachments = await claimAttachments(ctx, req.userId, ids);
    try {
      if (!attachments[0]!.contentType.startsWith('video/')) throw badRequest('Clips must be a video');
      const message = await createMessage(ctx, {
        channel: a.channel, authorId: req.userId, content: b.content ?? '', attachments,
        senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds,
      });
      await ctx.db.query('INSERT INTO clips (message_id, channel_id, author_id, duration_seconds) VALUES ($1,$2,$3,$4)',
        [message.id, id, req.userId, durationSeconds]);
      return reply.code(201).send(clipDTO(message, durationSeconds));
    } catch (e) {
      if (attachments.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]);
      throw e;
    }
  });

  app.get('/channels/:id/clips', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(listQuery, req.query);
    const a = await channelAccess(ctx, req.userId, id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const rows = await ctx.db.query(
      `SELECT m.*, c.duration_seconds FROM clips c JOIN messages m ON m.id = c.message_id
       WHERE c.channel_id = $1 AND ($2::text IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3`,
      [id, q.before ?? null, limitParam(q.limit)]);
    const messages = await messagesDTO(ctx, rows, req.userId);
    return messages.map((m, i) => clipDTO(m, rows[i]!.duration_seconds ?? null));
  });

  app.delete('/channels/:id/clips/:clipId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, clipId: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    const [clip] = await ctx.db.query(
      `SELECT m.id, m.author_id, m.attachments FROM clips c JOIN messages m ON m.id = c.message_id
       WHERE c.channel_id = $1 AND c.message_id = $2`, [p.id, p.clipId]);
    if (!clip) throw notFound('Clip');
    if (clip.author_id !== req.userId) {
      if (!a.channel.guild_id) throw forbidden('Only the author can delete this clip');
      need(a.perms, Perm.MANAGE_MESSAGES);
    }
    await ctx.db.query('DELETE FROM messages WHERE id = $1 AND channel_id = $2', [p.clipId, p.id]);
    await deleteAttachmentFiles(ctx, [clip.attachments]).catch((e) => ctx.log.warn({ err: e }, 'clip attachment cleanup failed'));
    await ctx.hub.toChannel(p.id, 'MESSAGE_DELETE', { id: p.clipId, channelId: p.id, guildId: a.channel.guild_id ?? null });
    return reply.code(204).send();
  });
}
