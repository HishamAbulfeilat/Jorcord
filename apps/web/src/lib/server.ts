/**
 * Server (backend) location + native wrapper detection.
 * Web served from the API's own origin keeps the empty default (same-origin `/api/v1`). Inside the Tauri / Capacitor
 * wrappers the bundle is served from a local origin, so the user types a server URL on first launch (docs/WRAPPER_WEB_NEEDS.md).
 */
const KEY = 'jorcord.server.v1';
let cached: string | null | undefined;
const listeners = new Set<() => void>();

const w = (): any => (typeof window === 'undefined' ? {} : window);

export const isTauri = () => !!(w().__TAURI__ || w().__TAURI_INTERNALS__);
export const isCapacitor = () => { try { return !!w().Capacitor?.isNativePlatform?.(); } catch { return false; } };
export const isNative = () => isTauri() || isCapacitor();
export type NativePlatform = 'tauri' | 'android' | 'ios' | null;
export function nativePlatform(): NativePlatform {
  if (isTauri()) return 'tauri';
  if (isCapacitor()) { const p = w().Capacitor?.getPlatform?.(); return p === 'ios' ? 'ios' : 'android'; }
  return null;
}
/** Capacitor plugin proxy registered by the native bridge (the plugins live in apps/mobile, not in this bundle). */
export const capPlugin = <T = any>(name: string): T | undefined => (isCapacitor() ? w().Capacitor?.Plugins?.[name] : undefined);

/** "chat.example.com", "localhost:3000", "https://x.y/" -> canonical origin without trailing slash, or null if unusable. */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

export function getServerUrl(): string {
  if (cached === undefined) { try { cached = localStorage.getItem(KEY) || null; } catch { cached = null; } }
  return cached ?? '';
}
export function setServerUrl(url: string | null) {
  cached = url || null;
  try { url ? localStorage.setItem(KEY, url) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  listeners.forEach((f) => f());
}
export const onServerChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Wrappers must pick a server before anything else works. */
/** Static hosting (GitHub Pages, any CDN) has no API on its own origin either: build with VITE_STATIC_HOST=1. */
export const isStaticHost = () => import.meta.env.VITE_STATIC_HOST === '1';
export const needsServerSetup = () => (isNative() || isStaticHost()) && !getServerUrl();

export const apiBase = () => `${getServerUrl()}/api/v1`;
/** Origin used for links we hand to people (invites, message links): the server when running in a wrapper. */
export const publicOrigin = () => getServerUrl() || (typeof location !== 'undefined' ? location.origin : '');
/** Prefix a server-relative path (`/api/v1/files/..`) with the server origin. Absolute URLs pass through. */
export const serverPath = (p: string) => (p.startsWith('/') && !p.startsWith('//') ? getServerUrl() + p : p);

export function gatewayUrl(): string {
  const s = getServerUrl();
  if (s) return s.replace(/^http/i, 'ws') + '/gateway';
  if (typeof location === 'undefined') return 'ws://localhost/gateway';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gateway`;
}

export type ServerCheck = { ok: true; origin: string } | { ok: false; error: string };
/** `GET {url}/health` must answer 2xx (JSON `{ok:true}` or similar). */
export async function validateServer(input: string, fetchImpl: typeof fetch = fetch): Promise<ServerCheck> {
  const origin = normalizeServerUrl(input);
  if (!origin) return { ok: false, error: 'Enter a valid server address, for example chat.example.com.' };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetchImpl(`${origin}/health`, { signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
    if (!res.ok) return { ok: false, error: `That address answered with an error (${res.status}). Is it a Jorcord server?` };
    const body = await res.json().catch(() => null);
    if (body && typeof body === 'object' && (body as any).ok === false) return { ok: false, error: 'The server reports that it is not healthy yet.' };
    return { ok: true, origin };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { ok: false, error: 'The server did not answer in time.' };
    return { ok: false, error: 'Could not reach that server. Check the address, your connection and that it allows this app (CORS_ORIGINS).' };
  }
}
