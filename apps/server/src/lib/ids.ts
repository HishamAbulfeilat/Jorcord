import { z } from 'zod';
import { ApiError } from '../errors';

export const idSchema = z.string().regex(/^\d{1,20}$/, 'invalid id');
export const isId = (s: unknown): s is string => typeof s === 'string' && /^\d{1,20}$/.test(s);

/** Validate with zod, mapping failures to a 400 ApiError. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}
export const iso = (v: unknown): string | null => (v ? new Date(v as any).toISOString() : null);
/** Safe URL for user-provided asset fields (avatars, icons): relative path or http(s). */
export const assetUrl = z.string().max(2048).refine((s) => /^(\/(?!\/)|https?:\/\/)/.test(s), 'must be an http(s) URL or path');
export const limitParam = (v: unknown, def = 50, max = 100) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : def;
};
