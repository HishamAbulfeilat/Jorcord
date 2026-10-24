/**
 * Lottie sticker safety. A Lottie file is JSON that a player turns into animation; it can also carry expressions
 * (JavaScript strings evaluated by the player) and image assets that point at arbitrary URLs. We render with the
 * expression-free `lottie_light` build AND sanitize the JSON first, so neither can be used to run code or make the
 * viewer's browser contact a third-party host.
 */
export const LOTTIE_MAX_BYTES = 512 * 1024;
const MAX_NODES = 150_000, MAX_DEPTH = 40, MAX_LAYERS = 300, MAX_DIM = 2048;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** Returns a cleaned deep copy, or null when the animation must not be rendered at all. */
export function sanitizeLottie(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.layers) || root.layers.length > MAX_LAYERS) return null;
  for (const k of ['w', 'h'] as const) { const v = root[k]; if (typeof v !== 'number' || !(v > 0) || v > MAX_DIM) return null; }
  let nodes = 0, bad = false;
  const walk = (v: unknown, depth: number, key: string): unknown => {
    if (bad) return null;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) { bad = true; return null; }
    if (typeof v === 'string') {
      if (key === 'x') return undefined; // expression source (After Effects expression strings live under "x")
      if (/(?:^|[^a-z])(?:javascript|data:text|vbscript):/i.test(v)) { bad = true; return null; }
      return v;
    }
    if (Array.isArray(v)) return v.map((e) => walk(e, depth + 1, key)).filter((e) => e !== undefined);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') { bad = true; return null; }
        const w = walk(val, depth + 1, k);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    return v;
  };
  const out = walk(root, 0, '') as Record<string, unknown> | null;
  if (bad || !out) return null;
  // image assets: embedded raster data only; external files (u + p) are refused outright
  const assets = Array.isArray(out.assets) ? (out.assets as Record<string, unknown>[]) : [];
  for (const a of assets) {
    if (a && typeof a === 'object' && ('p' in a || 'u' in a)) {
      if (typeof a.p !== 'string' || !DATA_IMAGE.test(a.p) || (typeof a.u === 'string' && a.u !== '')) return null;
    }
  }
  return out;
}
