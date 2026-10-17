/** Swappable HTTP transport. Default = fetch against /api/v1 with bearer auth + refresh. The /demo route swaps in a stub. */
import type { ApiError, FieldErrors } from '@jorcord/shared';
import { apiBase } from './server';
import { Limiter, parseRateLimit, rateLimitMessage, routeKey, retryAfterMs } from './ratelimit';

export class ApiException extends Error {
  status: number; code: string; details?: unknown;
  /** Discord-style numeric code (ErrorCode in @jorcord/shared), when the server sent one. */
  errorCode?: number;
  /** Field-level validation errors (`{ "answers.0.text": { _errors: [...] } }`). */
  errors?: FieldErrors;
  /** 429 only: how long the server asked us to wait, in ms. */
  retryAfterMs?: number;
  constructor(status: number, body: Partial<ApiError>, retryAfter?: number) {
    super(status === 429 ? rateLimitMessage(retryAfter ?? retryAfterMs(body)) : body.message ?? `Request failed (${status})`);
    this.status = status; this.code = body.code ?? 'UNKNOWN'; this.details = body.details; this.errorCode = body.errorCode; this.errors = body.errors;
    if (status === 429) this.retryAfterMs = retryAfter ?? retryAfterMs(body);
  }
  get rateLimited() { return this.status === 429; }
}

/** First field-level validation message of an error ("answers.0.text: Too long"), or null. */
export function fieldErrorSummary(e: unknown): string | null {
  const errs = (e as ApiException | undefined)?.errors;
  if (!errs) return null;
  for (const [path, v] of Object.entries(errs)) { const m = v?._errors?.[0]?.message; if (m) return `${path}: ${m}`; }
  return null;
}

/** Shared limiter: pauses calls to an exhausted route and retries short 429s. `setRateLimitNotifier` lets the UI show "retrying in Ns". */
export const limiter = new Limiter();
export const setRateLimitNotifier = (fn: ((ms: number, why: 'bucket' | '429') => void) | undefined) => { limiter.onWait = fn; };

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
  const key = routeKey(req.method, req.path);
  const run = async () => {
    await limiter.before(key);
    const headers: Record<string, string> = {};
    const { access } = tokens.get();
    if (access && req.auth !== false) headers.authorization = `Bearer ${access}`;
    let body: BodyInit | undefined;
    if (req.form) body = req.form;
    else if (req.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(req.body); }
    const r = await fetch(buildUrl(req.path, req.query), { method: req.method, headers, body, signal: req.signal });
    limiter.after(key, r.headers);
    return r;
  };
  /** A 429 never processed the request, so retrying is safe for every method. */
  const runLimited = async (): Promise<{ res: Response; data?: unknown }> => {
    for (let attempt = 0; ; attempt++) {
      const res = await run();
      if (res.status !== 429) return { res };
      const clone = res.clone();
      const data = await parse(clone);
      const info = parseRateLimit(429, data, res.headers)!;
      if (!(await limiter.handle429(key, info, attempt))) return { res, data };
    }
  };
  let res: Response; let early: unknown;
  try { ({ res, data: early } = await runLimited()); } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiException(0, { code: 'NETWORK', message: 'Cannot reach the server. Check your connection.' });
  }
  if (res.status === 401 && req.auth !== false && !req.path.startsWith('/auth/')) {
    refreshing ??= doRefresh().finally(() => { refreshing = null; });
    if (await refreshing) { ({ res, data: early } = await runLimited()); }
    else { tokens.onLogout(); }
  }
  const data = early !== undefined ? early : await parse(res);
  if (!res.ok) throw new ApiException(res.status, (typeof data === 'object' && data) || { message: String(data ?? '') }, res.status === 429 ? retryAfterMs(data, res.headers) : undefined);
  return data;
};

let current: Transport = fetchTransport;
export const setTransport = (t: Transport) => { current = t; };
export const getTransport = () => current;
export const send = <T = any>(req: Req): Promise<T> => current(req);
