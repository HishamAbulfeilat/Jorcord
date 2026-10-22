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

/** A clip is a single video attachment no longer than `ctx.config.clipMaxSeconds` (default 120 s, CLIP_MAX_SECONDS). */
export const MAX_CLIP_SECONDS = LIMITS.maxClipSeconds;
/** Slack for container rounding / the unknown length of a WebM's final cluster. */
const DURATION_SLACK_SECONDS = 0.5;
/** How much of the end of a WebM file is scanned for the last cluster timecode. */
const WEBM_TAIL_BYTES = 4 * 1024 * 1024;
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

// ---- WebM (EBML) duration ----
const ID_SEGMENT = 0x18538067, ID_INFO = 0x1549a966, ID_CLUSTER = 0x1f43b675, ID_TIMECODE_SCALE = 0x2ad7b1, ID_DURATION = 0x4489, ID_TIMECODE = 0xe7;

/** Reads an EBML element id (marker bits kept) or size (marker stripped; `null` value = unknown size). */
function vint(b: Buffer, o: number, id: boolean): { len: number; value: number | null } | null {
  if (o >= b.length) return null;
  const first = b[o]!;
  let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || (id && len > 4) || o + len > b.length) return null;
  let value = id ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === (0xff >> len);
  for (let i = 1; i < len; i++) { value = value * 256 + b[o + i]!; if (b[o + i] !== 0xff) allOnes = false; }
  return { len, value: !id && allOnes ? null : value };
}
const uint = (b: Buffer, o: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!; return v; };

/** TimecodeScale (ns per tick, default 1 ms) and Duration (in ticks, when the muxer wrote one) from the Info element near the start of a WebM. */
export function webmInfo(b: Buffer): { scaleNs: number; durationSeconds: number | null } {
  let scale = 1_000_000, ticks: number | null = null;
  const walk = (start: number, end: number, depth: number) => {
    let o = start;
    while (o < end) {
      const id = vint(b, o, true); if (!id) return;
      const size = vint(b, o + id.len, false); if (!size) return;
      const body = o + id.len + size.len, stop = size.value === null ? end : Math.min(end, body + size.value);
      if (id.value === ID_CLUSTER) return; // everything we need precedes the first cluster
      if (depth === 0 && id.value === ID_SEGMENT) walk(body, stop, 1);
      else if (depth === 1 && id.value === ID_INFO) walk(body, stop, 2);
      else if (depth === 2 && id.value === ID_TIMECODE_SCALE && size.value && size.value <= 8) scale = uint(b, body, size.value);
      else if (depth === 2 && id.value === ID_DURATION && (size.value === 4 || size.value === 8) && body + size.value <= b.length) ticks = size.value === 4 ? b.readFloatBE(body) : b.readDoubleBE(body);
      if (size.value === null) return;
      o = stop;
    }
  };
  walk(0, b.length, 0);
  return { scaleNs: scale > 0 ? scale : 1_000_000, durationSeconds: ticks !== null && Number.isFinite(ticks) && ticks > 0 ? (ticks * scale) / 1e9 : null };
}

/** Largest cluster timecode (ticks) found in `tail`: a Cluster id, its size, then the Timecode element. A lower bound of the media length. */
export function lastClusterTimecode(tail: Buffer): number | null {
  let best: number | null = null;
  for (let i = tail.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75])); i !== -1; i = tail.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]), i + 1)) {
    const size = vint(tail, i + 4, false); if (!size) continue;
    const tc = i + 4 + size.len;
    if (tail[tc] !== ID_TIMECODE) continue;
    const len = vint(tail, tc + 1, false);
    if (!len || len.value === null || len.value < 1 || len.value > 6 || tc + 1 + len.len + len.value > tail.length) continue;
    const v = uint(tail, tc + 1 + len.len, len.value);
    if (best === null || v > best) best = v;
  }
  return best;
}

/** Best known length (seconds) of a WebM from its head and tail bytes; null when the muxer left nothing to read. */
export function webmDuration(head: Buffer, tail: Buffer): number | null {
  const info = webmInfo(head);
  const tc = lastClusterTimecode(tail);
  const fromClusters = tc === null ? null : (tc * info.scaleNs) / 1e9;
  if (info.durationSeconds === null && fromClusters === null) return null;
  return Math.max(info.durationSeconds ?? 0, fromClusters ?? 0);
}

const clipBody = z.object({
  /** The uploaded file id to post (exactly one video). */
  attachmentId: idSchema.optional(),
  attachments: z.array(idSchema).max(1).optional(),
  content: z.string().max(LIMITS.maxMessageLength).optional(),
  // the real cap is ctx.config.clipMaxSeconds (checked in the handler with a precise message); this only bounds garbage
  durationSeconds: z.coerce.number().positive().max(LIMITS.maxClipSecondsCeiling).optional(),
  duration: z.coerce.number().positive().max(LIMITS.maxClipSecondsCeiling).optional(),
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

async function readRange(ctx: Ctx, key: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try { for await (const c of ctx.storage.get(key, { start, end })) chunks.push(c as Buffer); } catch { return Buffer.alloc(0); }
  return Buffer.concat(chunks);
}

export function clipRoutes(app: FastifyInstance, ctx: Ctx) {
  const maxSeconds = () => ctx.config.clipMaxSeconds;
  const tooLong = () => new ApiError(400, 'CLIP_TOO_LONG', `Clips can be at most ${maxSeconds()} seconds`, { maxSeconds: maxSeconds() });

  /** What the server accepts, so the recorder can tell which windows can be shared. */
  app.get('/clips/limits', async () => ({ maxSeconds: maxSeconds(), maxBytes: Math.min(MAX_CLIP_BYTES, ctx.config.maxUploadBytes) }));

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
    if (durationSeconds !== null && durationSeconds > maxSeconds() + DURATION_SLACK_SECONDS) throw tooLong(); // before claiming the upload
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
      // The client's claim is checked against the container when it can be read: MP4 mvhd, or for WebM (MediaRecorder writes
      // no Duration) the Info element plus the timecode of the last cluster at the end of the file.
      let real: number | null;
      if (kind === 'video/mp4') real = mp4Duration(head);
      else {
        const tailStart = Math.max(0, f.size - WEBM_TAIL_BYTES);
        const tail = f.size <= head.length ? head : await readRange(ctx, key, tailStart, f.size - 1);
        real = webmDuration(head, tail);
      }
      if (real !== null && real > maxSeconds() + DURATION_SLACK_SECONDS) throw tooLong();
      // a claim below what the container proves is corrected upwards, so a clip cannot dodge the cap by under-reporting
      if (real !== null && (durationSeconds === null || durationSeconds < real)) durationSeconds = Math.min(maxSeconds(), real);
      if (durationSeconds === null) throw badRequest('durationSeconds is required');
      durationSeconds = Math.min(maxSeconds(), Math.max(1, Math.ceil(durationSeconds)));
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
