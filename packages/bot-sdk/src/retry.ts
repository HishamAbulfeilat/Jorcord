/**
 * 429 handling for bots: waits exactly as long as the server says (`retry-after` header, or the more precise `retry_after`
 * seconds in the JSON body) and retries. Works with any fetch. See docs/BOTS.md#rate-limits.
 */
export interface RetryOptions {
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Never wait longer than this per retry; the 429 response is returned instead (default 60 s). */
  maxWaitMs?: number;
  /** Extra random wait up to this many ms so many bots do not retry in lockstep (default 100). */
  jitterMs?: number;
  /** Called before each wait, e.g. for logging. `global` = the whole-IP/user limit rather than one route's bucket. */
  onRateLimit?: (info: { waitMs: number; attempt: number; global: boolean; bucket: string | null; url: string }) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait in ms from a 429 response: body `retry_after` (fractional seconds) wins over the whole-second header. Never below 1 ms. */
export function retryAfterMs(res: { headers: { get(n: string): string | null } }, body?: any): number {
  const b = Number(body?.retry_after);
  if (body?.retry_after != null && Number.isFinite(b) && b >= 0) return Math.max(1, Math.ceil(b * 1000));
  const raw = res.headers.get('retry-after');
  const h = Number(raw);
  return raw != null && Number.isFinite(h) && h >= 0 ? Math.max(1, Math.ceil(h * 1000)) : 1000;
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, o: RetryOptions = {}): Promise<Response> {
  const f = o.fetchImpl ?? fetch; const sleep = o.sleep ?? defaultSleep; const max = o.maxRetries ?? 3; const cap = o.maxWaitMs ?? 60_000; const jitter = o.jitterMs ?? 100;
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, { ...init, signal: o.signal ?? init.signal });
    if (res.status !== 429 || attempt >= max) return res;
    let body: any = null;
    try { body = await res.clone().json(); } catch { /* header only */ }
    const waitMs = retryAfterMs(res, body);
    if (waitMs > cap) return res;
    o.onRateLimit?.({ waitMs, attempt: attempt + 1, global: body?.global === true || res.headers.get('x-ratelimit-global') === 'true', bucket: res.headers.get('x-ratelimit-bucket'), url });
    await sleep(waitMs + Math.floor(Math.random() * (jitter + 1)));
  }
}
