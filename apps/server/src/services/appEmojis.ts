import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { imageSize } from 'image-size';
import { APPLICATION_EMOJI_MAX_BYTES, snowflake, type ApplicationEmoji } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest } from '../errors';
import { fileUrl, sniffImageType } from './files';

export const appEmojiDTO = (r: any): ApplicationEmoji => ({ id: r.id, applicationId: r.application_id, name: r.name, animated: !!r.animated, url: r.url });

const DATA_URI = /^data:image\/(?:png|gif|webp|jpeg|jpg);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Whether the bytes are an animated GIF, animated WebP (ANIM chunk) or APNG (acTL chunk). */
export function isAnimatedImage(buf: Buffer): boolean {
  const kind = sniffImageType(buf);
  if (kind?.ext === 'gif') return true;
  if (kind?.ext === 'webp') return buf.subarray(0, Math.min(buf.length, 1024)).includes('ANIM');
  if (kind?.ext === 'png') return buf.subarray(0, Math.min(buf.length, 4096)).includes('acTL');
  return false;
}

/** Decodes a `data:image/...;base64,` URI (the shape bots send) and stores it like an upload. Returns the public file URL. */
export async function storeEmojiDataUri(ctx: Ctx, userId: string, image: string): Promise<{ url: string; animated: boolean }> {
  const m = DATA_URI.exec(image);
  if (!m) throw badRequest('image must be a base64 data URI (png, gif, webp or jpeg)');
  if (m[1]!.length > Math.ceil((APPLICATION_EMOJI_MAX_BYTES * 4) / 3) + 4) throw new ApiError(413, 'FILE_TOO_LARGE', 'Emoji images are limited to 256 KB');
  const buf = Buffer.from(m[1]!, 'base64');
  if (!buf.length || buf.length > APPLICATION_EMOJI_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Emoji images are limited to 256 KB');
  const kind = sniffImageType(buf); // magic bytes decide, never the declared type
  if (!kind) throw new ApiError(400, 'UNSUPPORTED_IMAGE_TYPE', 'Only PNG, JPEG, WEBP and GIF images are allowed');
  let width: number | null = null, height: number | null = null;
  try { const d = imageSize(buf); width = d.width ?? null; height = d.height ?? null; } catch { /* optional */ }
  const key = randomBytes(24).toString('hex'), filename = `emoji.${kind.ext}`;
  const size = await ctx.storage.put(key, Readable.from(buf), APPLICATION_EMOJI_MAX_BYTES + 1);
  if (size === 0) { await ctx.storage.delete(key); throw badRequest('The image is empty'); }
  await ctx.db.query('INSERT INTO files (id, key, uploader_id, filename, content_type, size, width, height, spoiler) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)',
    [snowflake(), key, userId, filename, kind.type, size, width, height]);
  return { url: fileUrl(key, filename), animated: isAnimatedImage(buf) };
}

/** An emoji by id from either table (guild or application), for `GET /emojis/:id`. */
export async function lookupEmoji(ctx: Ctx, id: string): Promise<{ id: string; name: string; animated: boolean; url: string; guildId: string | null; applicationId: string | null } | null> {
  const [g] = await ctx.db.query('SELECT id, name, animated, url, guild_id FROM emojis WHERE id = $1', [id]);
  if (g) return { id: g.id, name: g.name, animated: !!g.animated, url: g.url, guildId: g.guild_id, applicationId: null };
  const [a] = await ctx.db.query('SELECT id, name, animated, url, application_id FROM application_emojis WHERE id = $1', [id]);
  if (a) return { id: a.id, name: a.name, animated: !!a.animated, url: a.url, guildId: null, applicationId: a.application_id };
  return null;
}
