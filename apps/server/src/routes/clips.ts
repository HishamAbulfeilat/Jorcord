import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, Perm } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { claimAttachments, deleteAttachmentFiles } from '../services/files';
import { createMessage } from '../services/messages';
import { channelAccess, need } from '../services/perms';
import { messagesDTO } from '../services/serializers';

/** A clip is a single video attachment no longer than 30 seconds. */
export const MAX_CLIP_SECONDS = 30;
/** Largest clip file (also bounded by the server-wide upload limit). */
export const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const CLIP_TYPES = new Set(['video/mp4', 'video/webm']);

/** Container check by magic bytes: the declared Content-Type of an upload is attacker-controlled. */
export function sniffVideo(b: Buffer): 'video/mp4' | 'video/webm' | null {
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
}

/** Duration in seconds from an MP4's moov/mvhd box when it lies in `b` (null otherwise: e.g. moov at the end of a big file). */
export function mp4Duration(b: Buffer): number | null {
  const find = (start: number, end: number, name: string): [number, number] | null => {
    let o = start;
    while (o + 8 <= end) {
      let size = b.readUInt32BE(o); const type = b.toString('latin1', o + 4, o + 8); let hdr = 8;
      if (size === 1) { if (o + 16 > end) return null; size = Number(b.readBigUInt64BE(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr) return null;
      if (type === name) return [o + hdr, Math.min(o + size, end)];
      o += size;
    }
    return null;
  };
  const moov = find(0, b.length, 'moov'); if (!moov) return null;
  const mvhd = find(moov[0], moov[1], 'mvhd'); if (!mvhd) return null;
  const v = b[mvhd[0]];
  try {
    if (v === 1) return Number(b.readBigUInt64BE(mvhd[0] + 24)) / b.readUInt32BE(mvhd[0] + 20);
    const scale = b.readUInt32BE(mvhd[0] + 12);
    return scale > 0 ? b.readUInt32BE(mvhd[0] + 16) / scale : null;
  } catch { return null; }
}

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

/** Clips live only in channels an admin marked as clips channels (guild text-like channels). */
function requireClipsChannel(channel: any) {
  if (!channel.guild_id || !channel.is_clips_channel) throw badRequest('This channel is not a clips channel');
}

export function clipRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/channels/:id/clips', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(clipBody, req.body);
    const a = await channelAccess(ctx, req.userId, id);
    requireClipsChannel(a.channel);
    need(a.perms, Perm.SEND_MESSAGES, Perm.ATTACH_FILES);
    limitOrThrow(ctx.rl, `clip-post:${req.userId}`, 6, 60_000, ctx.config.rateLimit);
    const ids = [...(b.attachments ?? []), ...(b.attachmentId ? [b.attachmentId] : [])];
    if (ids.length !== 1) throw badRequest('Provide exactly one video attachment');
    let durationSeconds = b.durationSeconds ?? b.duration ?? null;
    const attachments = await claimAttachments(ctx, req.userId, ids);
    let messageId: string | null = null;
    try {
      const f = attachments[0]!;
      if (!CLIP_TYPES.has(f.contentType)) throw badRequest('Clips must be an MP4 or WebM video');
      if (f.size > Math.min(MAX_CLIP_BYTES, ctx.config.maxUploadBytes)) throw new ApiError(413, 'FILE_TOO_LARGE', `Clips can be at most ${MAX_CLIP_BYTES / 1024 / 1024} MB`);
      const key = f.url.split('/')[4] ?? '';
      const head = await ctx.storage.head(key, 1024 * 1024).catch(() => Buffer.alloc(0));
      const kind = sniffVideo(head);
      if (!kind || kind !== f.contentType) throw badRequest('The file is not a valid MP4 or WebM video');
      const real = kind === 'video/mp4' ? mp4Duration(head) : null; // the client's claim is checked against the container when it can be read
      if (real !== null && real > MAX_CLIP_SECONDS + 0.5) throw badRequest(`Clips can be at most ${MAX_CLIP_SECONDS} seconds`);
      if (durationSeconds === null && real !== null) durationSeconds = Math.min(MAX_CLIP_SECONDS, real);
      if (durationSeconds === null) throw badRequest('durationSeconds is required');
      durationSeconds = Math.max(1, Math.ceil(durationSeconds));
      const message = await createMessage(ctx, {
        channel: a.channel, authorId: req.userId, content: b.content ?? '', attachments,
        senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds,
      });
      messageId = message.id;
      await ctx.db.query('INSERT INTO clips (message_id, channel_id, author_id, duration_seconds) VALUES ($1,$2,$3,$4)',
        [message.id, id, req.userId, durationSeconds]);
      return reply.code(201).send(clipDTO(message, durationSeconds));
    } catch (e) {
      if (messageId) await ctx.db.query('DELETE FROM messages WHERE id = $1', [messageId]).catch(() => {}); // never leave a clip-less video message behind
      if (attachments.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]);
      throw e;
    }
  });

  app.get('/channels/:id/clips', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(listQuery, req.query);
    const a = await channelAccess(ctx, req.userId, id);
    requireClipsChannel(a.channel);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    limitOrThrow(ctx.rl, `clip-list:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
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
