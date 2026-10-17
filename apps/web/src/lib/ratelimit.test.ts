import { afterEach, describe, expect, it, vi } from 'vitest';
import { Limiter, parseRateLimit, rateLimitMessage, retryAfterMs, routeKey } from './ratelimit';
import { ApiException, fetchTransport, fieldErrorSummary, limiter } from './transport';

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe('rate limit parsing', () => {
  it('prefers the fractional body retry_after, then details.retryAfter, then the Retry-After header', () => {
    expect(retryAfterMs({ retry_after: 1.234, details: { retryAfter: 9 } }, h({ 'retry-after': '7' }))).toBe(1234);
    expect(retryAfterMs({ details: { retryAfter: 3 } }, h({ 'retry-after': '7' }))).toBe(3000);
    expect(retryAfterMs({}, h({ 'retry-after': '7' }))).toBe(7000);
    expect(retryAfterMs(undefined, undefined)).toBe(1000);
    expect(retryAfterMs({ retry_after: -4 }, undefined)).toBe(1000);
  });
  it('parseRateLimit only reacts to 429 and reads scope, bucket and global', () => {
    expect(parseRateLimit(200, {}, h({}))).toBeNull();
    expect(parseRateLimit(429, { retry_after: 2, global: true }, h({ 'x-ratelimit-scope': 'global', 'x-ratelimit-bucket': 'abc' }))).toEqual({ retryAfterMs: 2000, global: true, scope: 'global', bucket: 'abc' });
    expect(parseRateLimit(429, { retry_after: 2 }, h({ 'x-ratelimit-global': 'true' }))?.global).toBe(true);
  });
  it('formats a human message', () => {
    expect(rateLimitMessage(1)).toBe('You are being rate limited. Try again in 1 second.');
    expect(rateLimitMessage(2500)).toBe('You are being rate limited. Try again in 3 seconds.');
  });
  it('routeKey folds snowflakes and long tokens so one bucket covers a route shape', () => {
    expect(routeKey('post', '/channels/123456789012/messages')).toBe('POST /channels/:id/messages');
    expect(routeKey('PUT', '/channels/1/polls/222222222222/votes')).toBe('PUT /channels/1/polls/:id/votes');
    expect(routeKey('POST', `/interactions/123456/${'a'.repeat(30)}/callback`)).toBe('POST /interactions/:id/:token/callback');
  });
});

describe('Limiter', () => {
  const mk = (over: Partial<ConstructorParameters<typeof Limiter>[0]> = {}) => {
    let t = 1_000_000; const slept: number[] = [];
    const l = new Limiter({ now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, ...over });
    return { l, slept, advance: (ms: number) => { t += ms; } };
  };
  it('waits out an exhausted bucket before the next call on the same route only', async () => {
    const { l, slept } = mk();
    l.after('A', h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.5' }));
    await l.before('B'); expect(slept).toEqual([]);
    await l.before('A'); expect(slept).toEqual([1500]);
    await l.before('A'); expect(slept).toEqual([1500]); // paused no more
  });
  it('a response with remaining > 0 clears the pause', async () => {
    const { l, slept } = mk();
    l.after('A', h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '5' }));
    l.after('A', h({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset-after': '5' }));
    await l.before('A'); expect(slept).toEqual([]);
  });
  it('429 below the cap sleeps and asks for a retry; above the cap or after max retries it gives up', async () => {
    const { l, slept } = mk({ maxAutoWaitMs: 5000, maxRetries: 2 });
    expect(await l.handle429('A', { retryAfterMs: 2000, global: false, scope: null, bucket: null }, 0)).toBe(true); expect(slept).toEqual([2000]);
    expect(await l.handle429('A', { retryAfterMs: 9000, global: false, scope: null, bucket: null }, 0)).toBe(false);
    expect(await l.handle429('A', { retryAfterMs: 100, global: false, scope: null, bucket: null }, 2)).toBe(false);
  });
  it('a global 429 pauses every route', async () => {
    const { l, slept } = mk({ maxAutoWaitMs: 100 });
    await l.handle429('A', { retryAfterMs: 3000, global: true, scope: 'global', bucket: null }, 0); // too long to wait here, but recorded
    expect(l.pending('Z')).toBe(3000); expect(slept).toEqual([]);
  });
  it('reports waits to the UI hook', async () => {
    const seen: [number, string][] = []; const { l } = mk({ onWait: (ms, why) => seen.push([ms, why]) });
    await l.handle429('A', { retryAfterMs: 1200, global: false, scope: null, bucket: null }, 0);
    expect(seen).toEqual([[1200, '429']]);
  });
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('fetchTransport 429 handling', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); (limiter as unknown as { pauseUntil: Map<string, number> }).pauseUntil.clear(); });
  it('retries a short 429 once the Retry-After has elapsed and returns the data', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(429, { code: 'RATE_LIMITED', message: 'slow down', retry_after: 1.5, global: false }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchTransport({ method: 'POST', path: '/channels/123456789/messages', body: { content: 'x' }, auth: false });
    await vi.advanceTimersByTimeAsync(1400); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({ ok: true }); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('surfaces a long 429 as an ApiException carrying retryAfterMs without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(429, { code: 'RATE_LIMITED', message: 'x', retry_after: 30, errorCode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchTransport({ method: 'GET', path: '/guilds/123456789/audit-logs', auth: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiException); expect(err.status).toBe(429); expect(err.rateLimited).toBe(true); expect(err.retryAfterMs).toBe(30000);
    expect(err.message).toBe('You are being rate limited. Try again in 30 seconds.'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('an exhausted bucket makes the next call to that route wait', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' }))
      .mockResolvedValueOnce(json(200, { second: true }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchTransport({ method: 'GET', path: '/users/@me', auth: false });
    const p = fetchTransport({ method: 'GET', path: '/users/@me', auth: false });
    await vi.advanceTimersByTimeAsync(1000); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(p).resolves.toEqual({ second: true });
  });
  it('keeps Discord-style numeric codes and field errors on the exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(400, { code: 'VALIDATION_ERROR', message: 'Invalid form body', errorCode: 50035, errors: { 'answers.0.text': { _errors: [{ code: 'too_big', message: 'Too long' }] } } })));
    const err = await fetchTransport({ method: 'POST', path: '/x', auth: false }).catch((e) => e);
    expect(err.errorCode).toBe(50035); expect(fieldErrorSummary(err)).toBe('answers.0.text: Too long'); expect(fieldErrorSummary(new Error('x'))).toBeNull();
  });
});
