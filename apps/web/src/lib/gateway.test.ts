import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient, PROBE_TIMEOUT_MS, READY_TIMEOUT_MS, type GatewayStatus } from './gateway';

class FakeWS {
  static all: FakeWS[] = []; static autoAck = true;
  readyState = 0; sent: any[] = []; closedWith: number | null = null;
  onmessage: ((e: { data: string }) => void) | null = null; onclose: ((e: { code: number }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  send(d: string) { const m = JSON.parse(d); this.sent.push(m); if (m.op === 1 && FakeWS.autoAck) setTimeout(() => { if (this.readyState === 1) this.frame({ op: 11 }); }, 10); }
  close(code = 1000) { this.closedWith = code; this.readyState = 3; } // a real close fires onclose much later (or never); tests fire it explicitly
  // server side helpers
  open() { this.readyState = 1; }
  frame(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
  hello() { this.open(); this.frame({ op: 10, d: { heartbeatInterval: 10_000 } }); }
  ready() { this.frame({ op: 0, t: 'READY', s: 1, d: { sessionId: 'sess' } }); }
  resumed() { this.frame({ op: 0, t: 'RESUMED', s: 2, d: {} }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}
const last = () => FakeWS.all[FakeWS.all.length - 1]!;

let gw: GatewayClient; let seen: GatewayStatus[];
beforeEach(() => {
  vi.useFakeTimers(); FakeWS.all = []; FakeWS.autoAck = true;
  vi.stubGlobal('WebSocket', FakeWS);
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor 1.0
  gw = new GatewayClient('ws://test/gateway'); seen = []; gw.onStatus((s) => seen.push(s));
});
afterEach(() => { gw.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const connectReady = () => { gw.connect('tok'); last().hello(); last().ready(); };

describe('gateway state machine', () => {
  it('connecting -> connected on READY and IDENTIFYs with the token', () => {
    gw.connect('tok'); expect(gw.status).toBe('connecting');
    last().hello(); expect(last().sent[0]).toMatchObject({ op: 2, d: { token: 'tok' } });
    last().ready(); expect(gw.status).toBe('connected');
  });

  it('disconnect -> backoff -> RESUME -> RESUMED clears the reconnecting state', () => {
    connectReady();
    last().serverClose(1006); expect(gw.status).toBe('reconnecting');
    vi.advanceTimersByTime(600); expect(FakeWS.all).toHaveLength(2); expect(gw.status).toBe('reconnecting');
    last().hello(); expect(last().sent[0]).toMatchObject({ op: 6, d: { sessionId: 'sess' } });
    last().resumed(); expect(gw.status).toBe('connected');
  });

  it('invalid session (4009) falls back to IDENTIFY and a fresh READY clears the state', () => {
    connectReady(); last().serverClose(4009); vi.advanceTimersByTime(600);
    last().hello(); expect(last().sent[0].op).toBe(2); last().ready(); expect(gw.status).toBe('connected');
  });

  it('rapid disconnects keep one live socket and leave no stray timers once connected', () => {
    connectReady();
    last().serverClose(1006);
    // wake-up events fire while the backoff is pending: each reopens immediately, none may leave a second timer behind
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online'));
    const live = () => FakeWS.all.filter((w) => w.readyState !== 3 && w.closedWith === null);
    expect(live().length).toBeLessThanOrEqual(1);
    last().hello(); last().resumed(); expect(gw.status).toBe('connected');
    const after = FakeWS.all.length; vi.advanceTimersByTime(120_000); expect(FakeWS.all).toHaveLength(after);
  });

  it('READY never arrives: the watchdog tears the socket down and retries until it does', () => {
    gw.connect('tok'); last().open(); // opened, no HELLO / READY
    vi.advanceTimersByTime(READY_TIMEOUT_MS + 1); expect(FakeWS.all[0]!.closedWith).toBe(4000);
    expect(gw.status).toBe('reconnecting');
    vi.advanceTimersByTime(2000); expect(FakeWS.all).toHaveLength(2);
    last().hello(); last().ready(); expect(gw.status).toBe('connected');
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 3); expect(FakeWS.all).toHaveLength(2); // the watchdog is disarmed by READY
  });

  it('heartbeat ack timeout replaces the socket even if the dead one never reports its close', () => {
    FakeWS.autoAck = false; connectReady();
    vi.advanceTimersByTime(10_000); expect(last().sent.some((m) => m.op === 1)).toBe(true); // heartbeat, no ack
    vi.advanceTimersByTime(10_000); // second beat finds ackPending
    expect(FakeWS.all[0]!.closedWith).toBe(4000); expect(gw.status).toBe('reconnecting');
    vi.advanceTimersByTime(1000); expect(FakeWS.all).toHaveLength(2);
  });

  it('auth rejection (4004): repairs the token and reconnects; READY clears everything', () => {
    const repair = vi.fn(() => gw.reconnect('fresh')); gw.authFailed = repair;
    connectReady(); last().serverClose(4004);
    expect(repair).toHaveBeenCalledTimes(1); expect(FakeWS.all).toHaveLength(2);
    last().hello(); last().ready(); expect(gw.status).toBe('connected');
  });

  it('auth rejection that cannot be repaired ends in authfailed, not Reconnecting forever', () => {
    gw.authFailed = () => gw.reconnect('still-bad');
    gw.connect('tok');
    for (let i = 0; i < 5 && gw.status !== 'authfailed'; i++) { last().hello(); last().serverClose(4004); }
    expect(gw.status).toBe('authfailed');
    const n = FakeWS.all.length; vi.advanceTimersByTime(120_000); expect(FakeWS.all).toHaveLength(n); // no retry loop
    window.dispatchEvent(new Event('online')); expect(FakeWS.all).toHaveLength(n);
    gw.retryNow(); expect(FakeWS.all).toHaveLength(n + 1); last().hello(); last().ready(); expect(gw.status).toBe('connected');
  });

  it('auth repair that fails because the network is down falls back to the backoff', () => {
    gw.authFailed = () => gw.scheduleRetry();
    connectReady(); last().serverClose(4004);
    expect(gw.status).toBe('reconnecting'); vi.advanceTimersByTime(600); expect(FakeWS.all).toHaveLength(2);
  });

  it('a refresh token the server rejects marks the session failed', () => {
    gw.authFailed = () => gw.markAuthFailed();
    connectReady(); last().serverClose(4004); expect(gw.status).toBe('authfailed');
  });

  it('online event skips a long backoff', () => {
    connectReady();
    for (let i = 0; i < 6; i++) { last().serverClose(1006); vi.advanceTimersByTime(40_000); }
    last().serverClose(1006); const n = FakeWS.all.length; // now waiting up to 30 s
    window.dispatchEvent(new Event('online')); expect(FakeWS.all).toHaveLength(n + 1);
    last().hello(); last().resumed(); expect(gw.status).toBe('connected');
  });

  it('wake from sleep: a socket that looks open but is dead is detected by the probe', () => {
    FakeWS.autoAck = false; connectReady();
    document.dispatchEvent(new Event('visibilitychange')); // jsdom: visible
    expect(last().sent.filter((m) => m.op === 1)).toHaveLength(1);
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS + 1);
    expect(FakeWS.all[0]!.closedWith).toBe(4000); expect(gw.status).toBe('reconnecting');
  });

  it('an answered probe keeps the connection', () => {
    connectReady();
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS * 2); expect(gw.status).toBe('connected'); expect(FakeWS.all).toHaveLength(1);
  });

  it('logout / server switch: disconnect cancels timers and a later connect starts clean', () => {
    connectReady(); last().serverClose(1006); gw.disconnect();
    expect(gw.status).toBe('closed'); vi.advanceTimersByTime(120_000); expect(FakeWS.all).toHaveLength(1);
    gw.connect('tok2'); expect(gw.status).toBe('connecting'); // not 'reconnecting': retry counter and session were reset
    last().hello(); expect(last().sent[0].op).toBe(2);
  });

  it('disconnect during a pending watchdog does not resurrect the socket', () => {
    gw.connect('tok'); gw.disconnect(); vi.advanceTimersByTime(READY_TIMEOUT_MS * 2); expect(FakeWS.all).toHaveLength(1); expect(gw.status).toBe('closed');
  });
});
