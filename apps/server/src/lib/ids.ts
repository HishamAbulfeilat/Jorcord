import { z } from 'zod';
import { ApiError, fieldErrors } from '../errors';

export const idSchema = z.string().regex(/^\d{1,20}$/, 'invalid id');
export const isId = (s: unknown): s is string => typeof s === 'string' && /^\d{1,20}$/.test(s);

/** Validate with zod, mapping failures to a 400 ApiError. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))).with({ errors: fieldErrors(r.error.issues) });
  return r.data;
}
export const iso = (v: unknown): string | null => (v ? new Date(v as any).toISOString() : null);
/**
 * User-provided asset fields (avatars, banners, icons, emoji/sticker/event images, webhook avatars) accept only files hosted by this server
 * (the URL returned by an upload or by /users/@me/avatar/from-url). Arbitrary external URLs would make every viewer's client fetch from a
 * third-party host (IP leak / tracking); external images must be re-hosted through the from-url proxy first.
 */
export const OWN_FILE_RE = /^(?:\/api\/v1)?\/files\/[a-f0-9]{48}\/[^/?#\s\\]{1,600}$/;
export const assetUrl = z.string().max(2048).refine((s) => OWN_FILE_RE.test(s), 'must be a file uploaded to this server');
/** Looser URL for bot/webhook-authored content (message embeds, rich presence) where external images are the norm. */
export const externalUrl = z.string().max(2048).refine((s) => /^(\/(?!\/)|https?:\/\/)/.test(s), 'must be an http(s) URL or path');
export const limitParam = (v: unknown, def = 50, max = 100) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : def;
};
