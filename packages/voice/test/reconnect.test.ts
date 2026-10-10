import { describe, expect, it } from 'vitest';
import { backoffDelay, initialReconnect, lossReasonOf, reconnectReducer as step, statusOf, DEFAULT_BACKOFF, type ReconnectEvent, type ReconnectState } from '../src/reconnect';
import { parseConnectionStats } from '../src/stats';
import { mapVoiceError } from '../src/errors';
import { runDiagnostics, formatDiagnostics } from '../src/diagnostics';

const run = (events: ReconnectEvent[], from: ReconnectState = initialReconnect(3)) => events.reduce((s, e) => step(s, e), from);

describe('backoffDelay', () => {
  it('grows exponentially and caps', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
  it('jitter stays within +-jitter/2', () => {
    expect(backoffDelay(3, DEFAULT_BACKOFF, 0.4, () => 0)).toBe(3200);
    expect(backoffDelay(3, DEFAULT_BACKOFF, 0.4, () => 1)).toBe(4800);
  });
});

describe('reconnect state machine', () => {
  it('happy path', () => {
    const s = run([{ type: 'want' }, { type: 'connected' }]);
    expect(s).toMatchObject({ phase: 'connected', wanted: true, attempt: 0 });
    expect(statusOf(s.phase)).toBe('connected');
  });
  it('LiveKit resume keeps the session and returns to connected', () => {
    const s = run([{ type: 'want' }, { type: 'connected' }, { type: 'resuming' }]);
    expect(s.phase).toBe('resuming'); expect(statusOf(s.phase)).toBe('reconnecting');
    expect(step(s, { type: 'connected' }).phase).toBe('connected');
  });
  it('drop -> waiting with backoff -> rejoin -> failure doubles the delay -> success resets', () => {
    let s = run([{ type: 'want' }, { type: 'connected' }, { type: 'lost', reason: 'network' }]);
    expect(s).toMatchObject({ phase: 'waiting', attempt: 1, delayMs: 1000, reason: 'network' });
    s = run([{ type: 'attempt-start' }], s); expect(s.phase).toBe('rejoining');
    s = run([{ type: 'attempt-failed' }], s); expect(s).toMatchObject({ phase: 'waiting', attempt: 2, delayMs: 2000 });
    s = run([{ type: 'attempt-start' }, { type: 'connected' }], s);
    expect(s).toMatchObject({ phase: 'connected', attempt: 0, reason: null, wanted: true });
  });
  it('gives up after maxAttempts and a retry restarts the loop', () => {
    let s = run([{ type: 'want' }, { type: 'connected' }, { type: 'lost', reason: 'server' }]);
    for (let i = 0; i < 3; i++) s = run([{ type: 'attempt-start' }, { type: 'attempt-failed' }], s);
    expect(s).toMatchObject({ phase: 'failed', wanted: false }); expect(statusOf(s.phase)).toBe('disconnected');
    s = step(s, { type: 'retry-now' });
    expect(s).toMatchObject({ phase: 'rejoining', attempt: 1, wanted: true });
  });
  it('a fatal failure (e.g. token refused) stops immediately', () => {
    const s = run([{ type: 'want' }, { type: 'connected' }, { type: 'lost', reason: 'unknown' }, { type: 'attempt-start' }, { type: 'attempt-failed', fatal: true }]);
    expect(s.phase).toBe('failed');
  });
  it('being removed by a moderator is final: no retries', () => {
    const s = run([{ type: 'want' }, { type: 'connected' }, { type: 'lost', reason: 'removed' }]);
    expect(s).toMatchObject({ phase: 'idle', wanted: false });
  });
  it('retry-now while waiting skips the backoff', () => {
    const s = run([{ type: 'want' }, { type: 'connected' }, { type: 'lost', reason: 'network' }, { type: 'retry-now' }]);
    expect(s.phase).toBe('rejoining');
  });
  it('leave resets everything, and late events are ignored', () => {
    let s = run([{ type: 'want' }, { type: 'connected' }, { type: 'lost', reason: 'network' }, { type: 'leave' }]);
    expect(s).toEqual(initialReconnect(3));
    s = run([{ type: 'lost', reason: 'network' }, { type: 'attempt-start' }, { type: 'attempt-failed' }, { type: 'connected' }], s);
    expect(s.phase).toBe('idle');
  });
  it('maps LiveKit disconnect reasons', () => {
    expect([2, 4, 5, 10].map(lossReasonOf)).toEqual(['removed', 'removed', 'removed', 'removed']);
    expect([3, 6, 8, 9].every((r) => lossReasonOf(r) === 'server')).toBe(true);
    expect(lossReasonOf(undefined)).toBe('unknown');
  });
});

describe('parseConnectionStats', () => {
  const rep = (items: any[]) => new Map(items.map((i) => [i.id, i]));
  const base = [
    { id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.042, localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '127.0.0.1', port: 5000 },
    { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '127.0.0.1', port: 50001 },
  ];
  it('rtt, transport and candidates', () => {
    const { stats } = parseConnectionStats([rep(base)], 1000);
    expect(stats.rttMs).toBe(42); expect(stats.transport).toBe('udp'); expect(stats.localCandidate).toContain('127.0.0.1');
    expect(stats.packetLossPct).toBeNull();
  });
  it('detects tcp and relay paths', () => {
    const tcp = base.map((b) => (b.id === 'l' ? { ...b, protocol: 'tcp' } : b));
    expect(parseConnectionStats([rep(tcp)], 1).stats.transport).toBe('tcp');
    const relay = base.map((b) => (b.id === 'r' ? { ...b, candidateType: 'relay' } : b));
    expect(parseConnectionStats([rep(relay)], 1).stats.transport).toBe('relay');
  });
  it('packet loss and bitrate use deltas between samples', () => {
    const a = parseConnectionStats([rep([...base, { id: 'in', type: 'inbound-rtp', packetsReceived: 100, packetsLost: 0, bytesReceived: 10_000 }])], 0);
    const b = parseConnectionStats([rep([...base, { id: 'in', type: 'inbound-rtp', packetsReceived: 190, packetsLost: 10, bytesReceived: 135_000 }])], 2000, a.sample);
    expect(b.stats.packetLossPct).toBe(10); expect(b.stats.bitrateInKbps).toBe(500);
  });
  it('uses remote-inbound fractionLost for the outbound direction', () => {
    const a = parseConnectionStats([rep(base)], 0);
    const b = parseConnectionStats([rep([...base, { id: 'ri', type: 'remote-inbound-rtp', fractionLost: 51 }])], 1000, a.sample);
    expect(b.stats.packetLossPct).toBe(20);
  });
});

describe('error classification', () => {
  it('names the real reason of a failed join', () => {
    expect(mapVoiceError(Object.assign(new Error('x'), { name: 'ConnectionError', reason: 1 }), 'connect').code).toBe('signal-unreachable');
    expect(mapVoiceError(Object.assign(new Error('could not establish pc connection'), { reason: 5 }), 'connect').code).toBe('ice-failed');
    expect(mapVoiceError(Object.assign(new Error('unauthorized'), { reason: 0, status: 401 }), 'connect').code).toBe('token');
    expect(mapVoiceError(Object.assign(new Error('t'), { name: 'VoiceConnectTimeout', phase: 'signal' }), 'connect').code).toBe('timeout');
    expect(mapVoiceError(Object.assign(new Error('t'), { name: 'VoiceConnectTimeout', phase: 'ice' }), 'connect').code).toBe('ice-failed');
    expect(mapVoiceError(new Error('WebSocket connection failed'), 'connect').code).toBe('signal-unreachable');
    expect(mapVoiceError(new Error('???'), 'connect').code).toBe('connection');
  });
  it('every connect failure carries an actionable hint', () => {
    for (const code of ['signal-unreachable', 'ice-failed', 'timeout', 'token'] as const) {
      const e = mapVoiceError(code === 'token' ? { reason: 0 } : code === 'ice-failed' ? { message: 'pc connection' } : code === 'timeout' ? { name: 'VoiceConnectTimeout', phase: 'signal' } : { reason: 1 }, 'connect');
      expect(e.code).toBe(code); expect(e.hint).toBeTruthy();
    }
  });
});

describe('runDiagnostics', () => {
  it('reports an unreachable signalling server', async () => {
    const checks = await runDiagnostics({ signalUrl: 'ws://127.0.0.1:1', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any });
    const sig = checks.find((c) => c.id === 'signal')!;
    expect(sig.status).toBe('fail'); expect(formatDiagnostics(checks, { build: '1' })).toContain('build: 1');
  });
  it('reports ok when it answers', async () => {
    const checks = await runDiagnostics({ signalUrl: 'ws://127.0.0.1:7880', fetchImpl: (async () => ({ type: 'opaque' })) as any });
    expect(checks.find((c) => c.id === 'signal')!.status).toBe('ok');
  });
});
