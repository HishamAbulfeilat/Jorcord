import { safeGet, type SafeFetchResult } from './ssrf';

/**
 * Outbound HTTP for the Twitch / Google / YouTube integrations. Two shapes, both with timeouts and size caps:
 *  - `json`: API calls to a fixed allow-list of provider hosts (https only, no redirects, no credentials in the URL).
 *  - `page`: public YouTube pages / RSS through the SSRF-guarded `safeGet`, then the final host is checked again.
 * Callers go through the exported `http` object so tests can replace the transport without touching the network.
 */
const API_HOSTS = new Set(['id.twitch.tv', 'api.twitch.tv', 'oauth2.googleapis.com', 'www.googleapis.com']);
const PAGE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
const MAX_JSON_BYTES = 256 * 1024;

export class ProviderError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

export interface JsonResult { status: number; body: any }
export interface PageResult { status: number; body: string; url: string }

export const http = {
  async json(rawUrl: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; form?: Record<string, string>; timeoutMs?: number } = {}): Promise<JsonResult> {
    let u: URL; try { u = new URL(rawUrl); } catch { throw new ProviderError('Bad provider URL'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !API_HOSTS.has(u.hostname)) throw new ProviderError('Provider host not allowed');
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'JorcordBot/1.0', ...init.headers };
    let body: string | undefined;
    if (init.form) { body = new URLSearchParams(init.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    let res: Response;
    try { res = await fetch(u.href, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs ?? 8000) }); }
    catch (e: any) { throw new ProviderError(e?.name === 'TimeoutError' ? 'Provider timed out' : 'Provider unreachable'); }
    const text = await res.text().catch(() => '');
    if (text.length > MAX_JSON_BYTES) throw new ProviderError('Provider response too large', res.status);
    let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* non JSON (revoke endpoints answer 200 with an empty body) */ }
    return { status: res.status, body: parsed };
  },

  async page(rawUrl: string, o: { maxBytes?: number; accept?: string; allowPrivate?: boolean } = {}): Promise<PageResult> {
    let u: URL; try { u = new URL(rawUrl); } catch { throw new ProviderError('Bad URL'); }
    if (u.protocol !== 'https:' || u.username || u.password || !PAGE_HOSTS.has(u.hostname)) throw new ProviderError('Only youtube.com pages can be fetched');
    let r: SafeFetchResult;
    try { r = await safeGet(u.href, { maxBytes: o.maxBytes ?? 700_000, timeoutMs: 6000, maxRedirects: 2, accept: o.accept ?? 'text/html,*/*;q=0.5', allowPrivate: o.allowPrivate }); }
    catch (e: any) { throw new ProviderError(e?.message === 'SSRF_BLOCKED' ? 'Blocked address' : 'YouTube unreachable'); }
    let final: URL; try { final = new URL(r.url); } catch { throw new ProviderError('Bad redirect'); }
    if (!PAGE_HOSTS.has(final.hostname)) throw new ProviderError('YouTube redirected somewhere unexpected');
    return { status: r.status, body: r.body.toString('utf8'), url: r.url };
  },
};
