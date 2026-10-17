import type { Message } from '@jorcord/shared';

export interface FavoriteInput { url: string; preview?: string | null; title?: string | null; width?: number | null; height?: number | null }
const isFileUrl = (u: string) => /^\/api\/v1\/files\/[0-9a-f]{48}\/[^\s/?#]+$/.test(u);
const okUrl = (u: unknown): u is string => typeof u === 'string' && (/^https:\/\//i.test(u) || isFileUrl(u)) && u.length <= 2048;

/** The first GIF/image in a message that can be saved as a favorite (uploads first, then link embeds), or null. */
export function favoriteCandidate(m: Pick<Message, 'attachments' | 'embeds'>): FavoriteInput | null {
  const att = m.attachments.find((a) => /^image\/(gif|webp|png|jpeg|apng|avif)$/.test(a.contentType) && okUrl(a.url));
  if (att) return { url: att.url, title: att.filename.replace(/\.[^.]+$/, '').slice(0, 120), width: att.width, height: att.height };
  for (const e of m.embeds) {
    const url = okUrl(e.image) ? e.image : okUrl(e.thumbnail) ? e.thumbnail : null;
    if (url) return { url, preview: okUrl(e.thumbnail) && e.thumbnail !== url ? e.thumbnail : null, title: (e.title ?? '').slice(0, 120) || null };
  }
  return null;
}
