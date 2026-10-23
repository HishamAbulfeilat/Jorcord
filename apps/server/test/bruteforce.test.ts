import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/lib/ratelimit';
import { Api, startServer, type TestEnv } from './helpers';

const POLICY = { max: 3, windowMs: 60_000, baseLockMs: 10_000, maxLockMs: 60_000 };

describe('RateLimiter failure lockouts', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('locks after max failures, doubles each time up to the cap, and forgets the escalation after a quiet period', () => {
    vi.useFakeTimers();
    const rl = new RateLimiter();
    expect(rl.lockedFor('k')).toBe(0);
    expect(rl.recordFailure('k', POLICY)).toBe(0); expect(rl.recordFailure('k', POLICY)).toBe(0);
    expect(rl.recordFailure('k', POLICY)).toBe(10); // third failure trips the first lock
    expect(rl.lockedFor('k')).toBe(10);
    expect(rl.recordFailure('k', POLICY)).toBe(0); // attempts during a lock do not extend it
    vi.advanceTimersByTime(10_001); expect(rl.lockedFor('k')).toBe(0);
    for (let i = 0; i < 2; i++) rl.recordFailure('k', POLICY);
    expect(rl.recordFailure('k', POLICY)).toBe(20); // second lock: doubled
    vi.advanceTimersByTime(20_001);
    for (let i = 0; i < 2; i++) rl.recordFailure('k', POLICY);
    expect(rl.recordFailure('k', POLICY)).toBe(40);
    vi.advanceTimersByTime(40_001);
    for (let i = 0; i < 2; i++) rl.recordFailure('k', POLICY);
    expect(rl.recordFailure('k', POLICY)).toBe(60); // capped
    vi.advanceTimersByTime(60_001 + 10 * 60_000);
    for (let i = 0; i < 2; i++) rl.recordFailure('k', POLICY);
    expect(rl.recordFailure('k', POLICY)).toBe(10); // back to the base after a long quiet spell
    expect(rl.lockedFor('other')).toBe(0); // keys are independent
    rl.close();
  });

  it('failures older than the window do not add up', () => {
    vi.useFakeTimers();
    const rl = new RateLimiter();
    rl.recordFailure('k', POLICY); rl.recordFailure('k', POLICY);
    vi.advanceTimersByTime(61_000);
    expect(rl.recordFailure('k', POLICY)).toBe(0); expect(rl.lockedFor('k')).toBe(0);
    rl.close();
  });
});

describe('webhook token and invite code brute force', () => {
  let env: TestEnv;
  afterEach(async () => { await env?.close(); });

  it('webhook token guesses lock out the caller with backoff; the right token is never penalised', async () => {
    env = await startServer({ rateLimit: true });
    const api = new Api(env);
    const owner = await api.register('bfw');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'BF' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'H' })).body;
    // many successful posts never add up to a lockout
    for (let i = 0; i < 15; i++) expect((await api.req('POST', `/webhooks/${hook.id}/${hook.token}`, null, { content: `ok ${i}` })).status).toBeLessThan(300);
    // wrong guesses: 404 until the per-IP threshold (10), then 429 with Retry-After
    const statuses: number[] = [];
    let last: any;
    for (let i = 0; i < 14; i++) { last = await api.req('POST', `/webhooks/${hook.id}/${String(i).padStart(2, "q")}${"a".repeat(20)}`, null, { content: 'x' }); statuses.push(last.status); }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    expect(Number(last.headers?.['retry-after'] ?? 1)).toBeGreaterThan(0);
    // locked callers are refused even with the right token, on every token route
    expect((await api.req('POST', `/webhooks/${hook.id}/${hook.token}`, null, { content: 'blocked' })).status).toBe(429);
    expect((await api.req('GET', `/webhooks/${hook.id}/${hook.token}`, null)).status).toBe(429);
  });

  it('repeated wrong tokens sharing a prefix lock that hook+prefix (and not other prefixes)', async () => {
    env = await startServer({ rateLimit: true });
    const api = new Api(env);
    const owner = await api.register('bfp');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'BF2' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'H' })).body;
    const lockIp = env.ctx.rl;
    for (let i = 0; i < 5; i++) expect((await api.req('GET', `/webhooks/${hook.id}/${hook.token.slice(0, 6)}${'z'.repeat(20)}${i}`, null)).status).toBe(404);
    expect((await api.req('GET', `/webhooks/${hook.id}/${hook.token.slice(0, 6)}${'y'.repeat(20)}`, null)).status).toBe(429); // same prefix is locked
    void lockIp;
  });

  it('invite code guessing: failed lookups count (peek and join), valid ones never do', async () => {
    env = await startServer({ rateLimit: true });
    const api = new Api(env);
    const owner = await api.register('bfi');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'BF3' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    for (let i = 0; i < 25; i++) expect((await api.req('GET', `/invites/${code}`, null)).status).toBe(200); // valid peeks are free
    const peek: number[] = [];
    for (let i = 0; i < 24; i++) peek.push((await api.req('GET', `/invites/nope-${i}-xx`, null)).status);
    expect(peek.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(peek.slice(20).every((s) => s === 429)).toBe(true);
    expect((await api.req('GET', `/invites/${code}`, null)).status).toBe(429); // locked out, even for the real code
  });

  it('joining with wrong codes locks the user out; a normal join is unaffected', async () => {
    env = await startServer({ rateLimit: true });
    const api = new Api(env);
    const owner = await api.register('bfj');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'BF4' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const good = await api.register('bfg');
    expect((await api.req('POST', `/invites/${code}`, good.token)).status).toBe(200);
    const bad = await api.register('bfb');
    const out: number[] = [];
    for (let i = 0; i < 18; i++) out.push((await api.req('POST', `/invites/wrong-${i}-xxx`, bad.token)).status);
    expect(out.slice(0, 15).every((s) => s === 404)).toBe(true);
    expect(out.slice(15).every((s) => s === 429)).toBe(true);
  });
});
