import type { Embed } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { safeGet } from '../lib/ssrf';

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();
const meta = (html: string, key: string): string | undefined => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const v = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return v ? decode(v) : undefined;
};
const absolute = (u: string | undefined, base: string) => { if (!u) return undefined; try { const r = new URL(u, base); return r.protocol === 'http:' || r.protocol === 'https:' ? r.href : undefined; } catch { return undefined; } };

export async function unfurl(ctx: Pick<Ctx, 'config'>, rawUrl: string): Promise<Embed | null> {
  let u: URL; try { u = new URL(rawUrl); } catch { return null; }
  try {
    const res = await safeGet(u.href, { allowPrivate: ctx.config.allowPrivateUnfurl });
    if (res.status < 200 || res.status >= 300) return null;
    const ct = String(res.headers['content-type'] ?? '');
    if (ct.startsWith('image/')) return { type: 'image', url: res.url, image: res.url };
    if (!ct.includes('html')) return null;
    const html = res.body.toString('utf8');
    const title = meta(html, 'og:title') ?? meta(html, 'twitter:title') ?? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '');
    const description = meta(html, 'og:description') ?? meta(html, 'description') ?? meta(html, 'twitter:description');
    const image = absolute(meta(html, 'og:image') ?? meta(html, 'twitter:image'), res.url);
    const video = absolute(meta(html, 'og:video:url') ?? meta(html, 'og:video'), res.url);
    if (!title && !description && !image) return null;
    const color = meta(html, 'theme-color');
    return {
      type: video ? 'video' : 'link', url: res.url, title: title?.slice(0, 256) || undefined, description: description?.slice(0, 1000),
      thumbnail: image, video, siteName: meta(html, 'og:site_name')?.slice(0, 100),
      color: color && /^#[0-9a-f]{6}$/i.test(color) ? parseInt(color.slice(1), 16) : undefined,
    };
  } catch { return null; }
}
