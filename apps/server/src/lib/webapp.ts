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
const API_PREFIXES = ['/api', '/gateway', '/files', '/health', '/voice', '/oauth2', '/interactions', '/webhooks', '/push', '/livekit'];
/** Browser pages that live under an API-looking prefix: the add-bot consent page that every OAuth2 invite link points at (the API itself is /api/v1/oauth2/*). */
const WEB_PAGES = new Set(['/oauth2/authorize']);
export const isApiPath = (p: string) => !WEB_PAGES.has(p.replace(/\/+$/, '')) && API_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export interface CspOptions {
  /** Host (with port) the browser used for this page; its ws/wss variant is allowed for the gateway + proxied LiveKit signalling. */
  host?: string; secure?: boolean;
  /** Absolute LiveKit signalling origins from LIVEKIT_URL (ws/wss/http/https); empty for LIVEKIT_URL=auto (same origin). */
  livekitConnect?: string[];
  /** https origins of registered third-party embedded activities (frame-src allowlist; nothing else may be framed). */
  frameSrc?: string[];
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * Same-origin app CSP (the API's own `default-src 'none'` would blank the page). connect-src is derived, not a blanket
 * `ws: wss: https: http:`: this origin (gateway WebSocket, API, proxied /livekit), the LiveKit signalling origin from LIVEKIT_URL,
 * and, when LIVEKIT_URL names localhost but the page is opened via another host, that same port on the host in use.
 * Media itself (UDP/TCP ICE) is not governed by CSP.
 */
export function buildCsp(o: CspOptions = {}): string {
  const connect = new Set<string>(["'self'"]);
  const host = o.host?.trim();
  if (host && /^[a-z0-9.\-:\[\]]+$/i.test(host)) connect.add(`${o.secure ? 'wss' : 'ws'}://${host}`); // older Safari: 'self' does not cover ws(s)
  for (const src of o.livekitConnect ?? []) {
    connect.add(src);
    const m = /^(wss?|https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.exec(src);
    const hostname = host?.replace(/:\d+$/, '');
    if (m && hostname && !LOOPBACK.test(hostname) && /^[a-z0-9.\-\[\]:]+$/i.test(hostname)) connect.add(`${m[1]}://${hostname}${m[3] ?? ''}`);
  }
  return [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "media-src 'self' data: blob: https:",
    `connect-src ${[...connect].join(' ')}`, "worker-src 'self' blob:", "manifest-src 'self'", "object-src 'none'",
    `frame-src 'self'${(o.frameSrc ?? []).filter((x) => /^https:\/\/[a-z0-9.\-]+(:\d+)?$/i.test(x)).map((x) => ` ${x}`).join('')}`,
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}
export const WEB_CSP = buildCsp();

export interface WebApp { handle(req: FastifyRequest, reply: FastifyReply): Promise<boolean> }

function cacheControl(rel: string): string {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'; // content-hashed by Vite
  return 'no-cache'; // index.html, sw.js, registerSW.js, manifest, icons: always revalidate (ETag makes it cheap)
}

export function createWebApp(root: string, opts: { livekitConnect?: string[]; activityOrigins?: () => Promise<string[]> } = {}): WebApp {
  const base = resolve(root);

  async function send(req: FastifyRequest, reply: FastifyReply, abs: string, rel: string): Promise<boolean> {
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) return false;
    const frameSrc = rel === 'index.html' && opts.activityOrigins ? await opts.activityOrigins().catch(() => []) : [];
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    reply.header('etag', etag).header('last-modified', st.mtime.toUTCString()).header('cache-control', cacheControl(rel))
      .header('content-security-policy', buildCsp({ host: req.headers.host, secure: req.protocol === 'https', livekitConnect: opts.livekitConnect, frameSrc })).header('x-content-type-options', 'nosniff').header('cross-origin-resource-policy', 'same-origin')
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
