import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Serves the built web client (apps/web/dist) from the API's own origin so one container is the whole product.
 * Used from the 404 handler: real routes always win, then static files, then the SPA shell for browser navigations.
 * (Dependency-free on purpose: this is ~100 lines and keeps the lockfile/image unchanged.)
 */

/** Paths that belong to the backend: they never fall back to index.html, so API typos stay JSON 404s. */
const API_PREFIXES = ['/api', '/gateway', '/files', '/health', '/voice', '/oauth2', '/interactions', '/webhooks', '/push'];
export const isApiPath = (p: string) => API_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** Same-origin app CSP. The API's own `default-src 'none'` would blank the page. LiveKit/CDN media + GIF/embed images are https/wss. */
export const WEB_CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "media-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss: https: http:", "worker-src 'self' blob:", "manifest-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export interface WebApp { handle(req: FastifyRequest, reply: FastifyReply): Promise<boolean> }

function cacheControl(rel: string): string {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'; // content-hashed by Vite
  return 'no-cache'; // index.html, sw.js, registerSW.js, manifest, icons: always revalidate (ETag makes it cheap)
}

export function createWebApp(root: string): WebApp {
  const base = resolve(root);

  async function send(req: FastifyRequest, reply: FastifyReply, abs: string, rel: string): Promise<boolean> {
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) return false;
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    reply.header('etag', etag).header('last-modified', st.mtime.toUTCString()).header('cache-control', cacheControl(rel))
      .header('content-security-policy', WEB_CSP).header('x-content-type-options', 'nosniff').header('cross-origin-resource-policy', 'same-origin')
      .header('referrer-policy', 'same-origin').header('permissions-policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()');
    if (rel === 'sw.js') reply.header('service-worker-allowed', '/');
    if (req.headers['if-none-match'] === etag) { reply.code(304).send(); return true; }
    reply.type(TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream').header('content-length', st.size);
    if (req.method === 'HEAD') { reply.send(); return true; }
    reply.send(createReadStream(abs));
    return true;
  }

  return {
    async handle(req, reply) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      let path: string;
      try { path = decodeURIComponent(req.url.split('?')[0] ?? '/'); } catch { return false; }
      if (path.includes('\0') || path.includes('\\') || !path.startsWith('/') || isApiPath(path)) return false;
      const rel = path.replace(/^\/+/, '');
      if (rel) {
        const abs = resolve(join(base, rel));
        if (abs !== base && !abs.startsWith(base + sep)) return false; // path traversal
        if (await send(req, reply, abs, rel.replace(/\\/g, '/'))) return true;
      }
      // SPA fallback: only for browser navigations (Accept: text/html), never for missing assets / API-style requests.
      if (!(req.headers.accept ?? '').includes('text/html')) return false;
      return send(req, reply, join(base, 'index.html'), 'index.html');
    },
  };
}

/** True when `dir` holds a built web client. */
export async function hasWebBuild(dir: string): Promise<boolean> {
  return !!(await readFile(join(dir, 'index.html')).catch(() => null));
}
