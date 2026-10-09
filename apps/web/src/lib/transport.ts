/** Swappable HTTP transport. Default = fetch against /api/v1 with bearer auth + refresh. The /demo route swaps in a stub. */
import type { ApiError } from '@jorcord/shared';
import { apiBase } from './server';

export class ApiException extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, body: Partial<ApiError>) {
    super(body.message ?? `Request failed (${status})`);
    this.status = status; this.code = body.code ?? 'UNKNOWN'; this.details = body.details;
  }
}

export interface Req { method: string; path: string; query?: Record<string, unknown>; body?: unknown; form?: FormData; auth?: boolean; signal?: AbortSignal }
export type Transport = (req: Req) => Promise<any>;

export interface TokenStore {
  get(): { access: string | null; refresh: string | null };
  set(a: string | null, r: string | null): void;
  onLogout(): void;
}
let tokens: TokenStore = {
  get: () => ({ access: null, refresh: null }), set() {}, onLogout() {},
};
export const bindTokenStore = (t: TokenStore) => { tokens = t; };

/** Resolved per call: wrappers can switch servers at runtime. */
export const API_BASE_PATH = '/api/v1';

export function buildUrl(path: string, query?: Record<string, unknown>) {
  const u = apiBase() + path;
  if (!query) return u;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `${u}?${s}` : u;
}

let refreshing: Promise<boolean> | null = null;
async function doRefresh(): Promise<boolean> {
  const { refresh } = tokens.get();
  if (!refresh) return false;
  try {
    const res = await fetch(apiBase() + '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) });
    if (!res.ok) return false;
    const j = await res.json();
    tokens.set(j.accessToken, j.refreshToken ?? refresh);
    return true;
  } catch { return false; }
}

async function parse(res: Response) {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

export const fetchTransport: Transport = async (req) => {
  const run = async () => {
    const headers: Record<string, string> = {};
    const { access } = tokens.get();
    if (access && req.auth !== false) headers.authorization = `Bearer ${access}`;
    let body: BodyInit | undefined;
    if (req.form) body = req.form;
    else if (req.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(req.body); }
    return fetch(buildUrl(req.path, req.query), { method: req.method, headers, body, signal: req.signal });
  };
  let res: Response;
  try { res = await run(); } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiException(0, { code: 'NETWORK', message: 'Cannot reach the server. Check your connection.' });
  }
  if (res.status === 401 && req.auth !== false && !req.path.startsWith('/auth/')) {
    refreshing ??= doRefresh().finally(() => { refreshing = null; });
    if (await refreshing) res = await run();
    else { tokens.onLogout(); }
  }
  const data = await parse(res);
  if (!res.ok) throw new ApiException(res.status, (typeof data === 'object' && data) || { message: String(data ?? '') });
  return data;
};

let current: Transport = fetchTransport;
export const setTransport = (t: Transport) => { current = t; };
export const getTransport = () => current;
export const send = <T = any>(req: Req): Promise<T> => current(req);
