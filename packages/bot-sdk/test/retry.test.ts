import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, retryAfterMs } from '../src/retry';
import { Rest } from '../src/index';

const res429 = (body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', ...headers } });
const ok = () => new Response('{"ok":true}', { status: 200 });

describe('fetchWithRetry', () => {
  it('waits for retry_after (ms precision) and retries until success', async () => {
    const f = vi.fn().mockResolvedValueOnce(res429({ retry_after: 0.25 }, { 'retry-after': '1' })).mockResolvedValueOnce(ok());
    const waits: number[] = []; const seen = vi.fn();
    const r = await fetchWithRetry('http://x/api', {}, { fetchImpl: f as any, jitterMs: 0, sleep: async (ms) => { waits.push(ms); }, onRateLimit: seen });
    expect(r.status).toBe(200); expect(waits).toEqual([250]); expect(f).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ waitMs: 250, attempt: 1, global: false }));
  });
  it('falls back to the retry-after header, flags global limits, and defaults to 1 s', async () => {
    const f = vi.fn().mockResolvedValueOnce(res429({ global: true }, { 'retry-after': '2', 'x-ratelimit-bucket': 'abc' })).mockResolvedValueOnce(new Response('x', { status: 429 })).mockResolvedValueOnce(ok());
    const waits: number[] = []; const seen = vi.fn();
    await fetchWithRetry('http://x', {}, { fetchImpl: f as any, jitterMs: 0, sleep: async (ms) => { waits.push(ms); }, onRateLimit: seen });
    expect(waits).toEqual([2000, 1000]); expect(seen.mock.calls[0]![0]).toMatchObject({ global: true, bucket: 'abc' });
  });
  it('gives up after maxRetries and returns the last 429', async () => {
    const f = vi.fn(async () => res429({ retry_after: 0.01 }));
    const r = await fetchWithRetry('http://x', {}, { fetchImpl: f as any, maxRetries: 2, jitterMs: 0, sleep: async () => {} });
    expect(r.status).toBe(429); expect(f).toHaveBeenCalledTimes(3);
  });
  it('does not wait longer than maxWaitMs', async () => {
    const f = vi.fn(async () => res429({ retry_after: 120 })); const sleep = vi.fn(async () => {});
    const r = await fetchWithRetry('http://x', {}, { fetchImpl: f as any, sleep });
    expect(r.status).toBe(429); expect(sleep).not.toHaveBeenCalled(); expect(f).toHaveBeenCalledTimes(1);
  });
  it('never retries non-429 errors', async () => {
    const f = vi.fn(async () => new Response('no', { status: 500 }));
    expect((await fetchWithRetry('http://x', {}, { fetchImpl: f as any })).status).toBe(500); expect(f).toHaveBeenCalledTimes(1);
  });
  it('parses waits', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }) as any && { headers: new Headers({ 'retry-after': '3' }) })).toBe(3000);
    expect(retryAfterMs({ headers: new Headers() }, { retry_after: 0.0004 })).toBe(1);
  });
});

describe('Rest uses it', () => {
  it('retries a 429 transparently', async () => {
    const f = vi.fn().mockResolvedValueOnce(res429({ retry_after: 0.01 })).mockResolvedValueOnce(ok());
    const real = globalThis.fetch; (globalThis as any).fetch = f;
    try { expect(await new Rest('http://x', 't', { sleep: async () => {}, jitterMs: 0 }).get('/a')).toEqual({ ok: true }); } finally { globalThis.fetch = real; }
    expect(f).toHaveBeenCalledTimes(2);
  });
});
