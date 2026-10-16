import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { MultipartFile } from '@fastify/multipart';
import { imageSize } from 'image-size';
import { snowflake, type Attachment } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, notFound } from '../errors';
import { safeGet } from '../lib/ssrf';

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

/** Max size of an avatar/banner fetched from a URL. */
export const MAX_PROFILE_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = [
  { type: 'image/png', ext: 'png', match: (b: Buffer) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { type: 'image/jpeg', ext: 'jpg', match: (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', match: (b: Buffer) => b.length >= 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') },
  { type: 'image/webp', ext: 'webp', match: (b: Buffer) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

/** Allowed profile image type by magic bytes, never by the server-supplied Content-Type. */
export function sniffImageType(buf: Buffer): { type: string; ext: string } | null {
  const hit = IMAGE_TYPES.find((t) => t.match(buf));
  return hit ? { type: hit.type, ext: hit.ext } : null;
}

/**
 * Downloads an image through the SSRF guard and stores it exactly like an upload (a `files` row + the public URL).
 * Rejects non-http(s)/private/oversized/non-image responses; `basename` names the stored file (e.g. "avatar").
 */
export async function storeImageFromUrl(ctx: Ctx, userId: string, url: string, basename: string): Promise<string> {
  let res: Awaited<ReturnType<typeof safeGet>>;
  try { res = await safeGet(url, { maxBytes: MAX_PROFILE_IMAGE_BYTES, timeoutMs: 10_000, allowPrivate: ctx.config.allowPrivateUnfurl }); }
  catch { throw badRequest('Could not fetch an image from that URL'); }
  if (res.status < 200 || res.status >= 300) throw badRequest('That URL did not return an image');
  const declared = Number(res.headers['content-length'] ?? 0);
  if (res.truncated || declared > MAX_PROFILE_IMAGE_BYTES || res.body.length > MAX_PROFILE_IMAGE_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Image exceeds 8 MB');
  const kind = sniffImageType(res.body);
  if (!kind) throw new ApiError(400, 'UNSUPPORTED_IMAGE_TYPE', 'Only PNG, JPEG, WEBP and GIF images are allowed');
  const key = randomBytes(24).toString('hex');
  const filename = `${basename}.${kind.ext}`;
  let width: number | null = null, height: number | null = null;
  try { const d = imageSize(res.body); width = d.width ?? null; height = d.height ?? null; } catch { /* dimensions are optional */ }
  const size = await ctx.storage.put(key, Readable.from(res.body), MAX_PROFILE_IMAGE_BYTES);
  if (size === 0) { await ctx.storage.delete(key); throw badRequest('The image is empty'); }
  await ctx.db.query('INSERT INTO files (id, key, uploader_id, filename, content_type, size, width, height, spoiler) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)',
    [snowflake(), key, userId, filename, kind.type, size, width, height]);
  return fileUrl(key, filename);
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
