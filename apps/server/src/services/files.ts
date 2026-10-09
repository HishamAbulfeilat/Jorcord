import { randomBytes } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import { imageSize } from 'image-size';
import { snowflake, type Attachment } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, notFound } from '../errors';

export const sanitizeFilename = (name: string) => {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return base || 'file';
};
export const fileUrl = (key: string, filename: string) => `/api/v1/files/${key}/${encodeURIComponent(filename)}`;

/** Content types safe to render inline. Everything else is served as an octet-stream download. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac', 'audio/mp4']);
export const isInlineType = (t: string) => INLINE.has(t);

/** Uploads a user may have outstanding (not yet attached to a message). Stops anonymous-storage abuse via /uploads. */
export const MAX_UNATTACHED_UPLOADS = 100;

export async function saveUpload(ctx: Ctx, userId: string, part: MultipartFile): Promise<Attachment> {
  const [pending] = await ctx.db.query('SELECT count(*)::int AS n FROM files WHERE uploader_id = $1 AND NOT attached', [userId]);
  if (pending.n >= MAX_UNATTACHED_UPLOADS) { part.file.resume(); throw new ApiError(429, 'TOO_MANY_UPLOADS', 'Too many unsent uploads; send or discard some first'); }
  const key = randomBytes(24).toString('hex');
  const filename = sanitizeFilename(part.filename);
  let contentType = (part.mimetype || 'application/octet-stream').toLowerCase().replace(/[^\x21-\x7e]/g, '').slice(0, 100) || 'application/octet-stream';
  let size: number;
  try { size = await ctx.storage.put(key, part.file, ctx.config.maxUploadBytes); }
  catch (e: any) {
    if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.message === 'FILE_TOO_LARGE') throw new ApiError(413, 'FILE_TOO_LARGE', `File exceeds ${ctx.config.maxUploadBytes} bytes`);
    throw e;
  }
  if ((part.file as any).truncated) { await ctx.storage.delete(key); throw new ApiError(413, 'FILE_TOO_LARGE', `File exceeds ${ctx.config.maxUploadBytes} bytes`); }
  if (size === 0) { await ctx.storage.delete(key); throw new ApiError(400, 'EMPTY_FILE', 'File is empty'); }
  let width: number | null = null, height: number | null = null;
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(contentType)) {
    try { const d = imageSize(await ctx.storage.head(key, 262144)); width = d.width ?? null; height = d.height ?? null; }
    catch { contentType = 'application/octet-stream'; } // claims to be an image but is not one: never serve it inline as an image
  }
  const id = snowflake();
  await ctx.db.query('INSERT INTO files (id, key, uploader_id, filename, content_type, size, width, height, spoiler) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, key, userId, filename, contentType, size, width, height, filename.startsWith('SPOILER_')]);
  return { id, filename, contentType, size, url: fileUrl(key, filename), width, height, spoiler: filename.startsWith('SPOILER_') };
}

const toAttachment = (f: any): Attachment => ({ id: f.id, filename: f.filename, contentType: f.content_type, size: Number(f.size), url: fileUrl(f.key, f.filename), width: f.width ?? null, height: f.height ?? null, spoiler: f.spoiler });

/** Claims previously uploaded files for a message. Files must belong to the sender and be unattached (IDOR guard). */
export async function claimAttachments(ctx: Ctx, userId: string, ids: string[]): Promise<Attachment[]> {
  if (!ids.length) return [];
  const uniq = [...new Set(ids)];
  const rows = await ctx.db.query('UPDATE files SET attached = true WHERE id = ANY($1::text[]) AND uploader_id = $2 AND NOT attached RETURNING *', [uniq, userId]);
  if (rows.length !== uniq.length) {
    // roll back partial claims
    if (rows.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [rows.map((r) => r.id)]);
    throw notFound('Attachment');
  }
  return uniq.map((id) => toAttachment(rows.find((r) => r.id === id)));
}
