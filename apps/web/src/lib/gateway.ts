/** Gateway client: HELLO -> IDENTIFY/RESUME, heartbeat w/ ack watchdog, exponential reconnect, typed events. Swappable via `GatewayLike`. */
import { gatewayUrl } from './server';
import { Op, type EventName, type Events, type GatewayFrame, type VoiceStateUpdatePayload } from '@jorcord/shared';

/** `authfailed`: the server rejected our token and it could not be repaired (the banner offers to sign in again). */
export type GatewayStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'authfailed';

/** How long a socket may take to deliver READY/RESUMED (connect + HELLO + IDENTIFY) before it is torn down and retried. */
export const READY_TIMEOUT_MS = 20_000;
/** How long a heartbeat probe (after wake / tab focus) may stay unanswered before the socket counts as dead. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Consecutive auth rejections tolerated (each followed by a token repair) before giving up with `authfailed`. */
const MAX_AUTH_FAILS = 2;
export interface GatewayLike {
  connect(token: string): void;
  disconnect(): void;
  on<K extends EventName>(event: K, fn: (d: Events[K]) => void): () => void;
  onStatus(fn: (s: GatewayStatus) => void): () => void;
  sendTyping(channelId: string): void;
  updatePresence(presence: string): void;
  updateVoiceState(p: VoiceStateUpdatePayload): void;
  /** Op REQUEST_MEMBERS (8): server answers with GUILD_MEMBERS_CHUNK. */
  requestMembers?(p: { guildId: string; query?: string; userIds?: string[]; limit?: number; after?: string; nonce?: string }): void;
  /** Skip any backoff and reconnect right now (the banner's "Retry now"). */
  retryNow?(): void;
  readonly status: GatewayStatus;
}

export class GatewayClient implements GatewayLike {
  status: GatewayStatus = 'idle';
  private ws: WebSocket | null = null;
  private token = '';
  private sessionId: string | null = null;
  private seq = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private ackPending = false;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manual = false;
  private handlers = new Map<string, Set<(d: any) => void>>();
  private statusHandlers = new Set<(s: GatewayStatus) => void>();
  private lastTyping = new Map<string, number>();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private authFails = 0;

  constructor(private urlOverride?: string) {
    if (typeof window !== 'undefined') {
      // the network is back: do not sit out a 30 s backoff, and do not trust a socket that was open while the network was gone
      window.addEventListener('online', () => {
        if (this.manual || !this.token || this.status === 'authfailed') return;
        if (this.status !== 'connected') { this.retry = 0; this.open(); } else this.probe();
      });
      // going offline: the socket usually does not notice for a whole heartbeat interval, so check it right away
      window.addEventListener('offline', () => { if (!this.manual && this.status === 'connected') this.probe(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || this.manual || !this.token || this.status === 'authfailed') return;
        if (!this.ws || this.ws.readyState > 1) { this.retry = 0; this.open(); } // woke up from sleep with a dead socket
        else if (this.status === 'connected') this.probe(); // looks open, might be half-open after sleep
      });
    }
  }

  /** Send a heartbeat now; if nothing comes back soon the socket is dead and gets replaced. */
  private probe() {
    if (this.probeTimer || this.ws?.readyState !== 1) return;
    const ws = this.ws; this.ackPending = true; this.raw(Op.HEARTBEAT, this.seq);
    this.probeTimer = setTimeout(() => { this.probeTimer = null; if (this.ws === ws && this.ackPending) this.dropSocket(ws, 4000); }, PROBE_TIMEOUT_MS);
  }
  /** Close `ws` and handle the close ourselves: a dead socket can take minutes to report its own close. */
  private dropSocket(ws: WebSocket, code: number) {
    try { ws.close(code === 1000 ? 1000 : 4000); } catch { /* noop */ }
    this.handleClose(ws, code);
  }
  retryNow() { if (this.manual || !this.token) return; this.retry = 0; this.authFails = 0; this.open(); }

  on<K extends EventName>(event: K, fn: (d: Events[K]) => void) {
    let s = this.handlers.get(event); if (!s) this.handlers.set(event, (s = new Set()));
    s.add(fn); return () => { s!.delete(fn); };
  }
  onStatus(fn: (s: GatewayStatus) => void) { this.statusHandlers.add(fn); return () => { this.statusHandlers.delete(fn); }; }
  private setStatus(s: GatewayStatus) { this.status = s; this.statusHandlers.forEach((f) => f(s)); }
  private emit(t: string, d: unknown) { this.handlers.get(t)?.forEach((f) => { try { f(d); } catch (e) { console.error('[gateway] handler error', t, e); } }); this.handlers.get('*')?.forEach((f) => f({ t, d })); }

  connect(token: string) { this.token = token; this.manual = false; this.sessionId = null; this.seq = 0; this.retry = 0; this.authFails = 0; this.open(); }
  disconnect() {
    this.manual = true; this.cleanup(); this.sessionId = null; this.token = ''; this.retry = 0; this.authFails = 0;
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onmessage = null; ws.onclose = null; try { ws.close(1000); } catch { /* noop */ } }
    this.setStatus('closed');
  }
  private cleanup() {
    if (this.hbTimer) clearInterval(this.hbTimer); this.hbTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null;
    if (this.probeTimer) clearTimeout(this.probeTimer); this.probeTimer = null;
  }
  private open() {
    this.cleanup();
    const old = this.ws;
    if (old) { old.onmessage = null; old.onclose = null; if (old.readyState <= 1) { try { old.close(); } catch { /* noop */ } } }
    this.setStatus(this.retry > 0 || this.sessionId ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.urlOverride ?? gatewayUrl()); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onmessage = (ev) => { try { this.onFrame(JSON.parse(String(ev.data))); } catch (e) { console.error('[gateway] bad frame', e); } };
    ws.onclose = (ev) => this.handleClose(ws, ev.code);
    ws.onerror = () => { /* close follows */ };
    // watchdog: a socket that opened (or never opened) but whose READY never arrives must not leave the status stuck
    this.readyTimer = setTimeout(() => { this.readyTimer = null; if (this.ws === ws && this.status !== 'connected') this.dropSocket(ws, 4000); }, READY_TIMEOUT_MS);
  }
  private handleClose(ws: WebSocket, code: number) {
    if (this.ws !== ws) return;
    this.cleanup();
    ws.onclose = null; ws.onmessage = null;
    if (this.manual) return;
    if (code === 4004 || code === 4001) {
      this.sessionId = null; this.seq = 0;
      if (++this.authFails > MAX_AUTH_FAILS || !this.authFailed) { this.setStatus('authfailed'); return; }
      this.setStatus('reconnecting'); this.authFailed(); return;
    }
    if (code === 4009 || code === 4007) { this.sessionId = null; this.seq = 0; }
    this.scheduleReconnect();
  }
  authFailed?: () => void;
  getToken?: () => string | null;
  /** Re-open after auth was repaired (token refreshed). */
  reconnect(token: string) { this.token = token; this.manual = false; this.open(); }
  /** The auth repair could not reach the server (offline): fall back to the normal backoff instead of waiting forever. */
  /** The session is really gone (refresh rejected): stop retrying and let the banner offer a sign-in. */
  markAuthFailed() { if (this.manual) return; this.cleanup(); this.setStatus('authfailed'); }
  scheduleRetry() { if (!this.manual && this.token) this.scheduleReconnect(); }

  private scheduleReconnect() {
    this.cleanup();
    this.setStatus('reconnecting');
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retry, 6)) * (0.7 + Math.random() * 0.6);
    this.retry++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
  private raw(op: number, d?: unknown) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d })); }

  private onFrame(f: GatewayFrame<any>) {
    if (typeof f.s === 'number') this.seq = f.s;
    switch (f.op) {
      case Op.HELLO: {
        const interval = f.d?.heartbeatInterval ?? 30_000;
        this.ackPending = false;
        if (this.hbTimer) clearInterval(this.hbTimer);
        this.hbTimer = setInterval(() => {
          if (this.ackPending) { if (this.ws) this.dropSocket(this.ws, 4000); return; }
          this.ackPending = true; this.raw(Op.HEARTBEAT, this.seq);
        }, interval);
        if (this.sessionId) this.raw(Op.RESUME, { token: this.getToken?.() ?? this.token, sessionId: this.sessionId, seq: this.seq });
        else this.raw(Op.IDENTIFY, { token: this.getToken?.() ?? this.token, properties: { os: navigator.platform, client: 'jorcord-web' } });
        break;
      }
      case Op.HEARTBEAT: this.raw(Op.HEARTBEAT, this.seq); break;
      case Op.HEARTBEAT_ACK: this.ackPending = false; if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; } break;
      case Op.RECONNECT: if (this.ws) this.dropSocket(this.ws, 4000); break;
      case Op.DISPATCH: {
        if (f.t === 'READY') { this.sessionId = f.d.sessionId; this.ready(); }
        else if (f.t === 'RESUMED') this.ready();
        if (f.t) this.emit(f.t, f.d);
        break;
      }
    }
  }
  private ready() {
    this.retry = 0; this.authFails = 0;
    if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null;
    this.setStatus('connected');
  }
  sendTyping(channelId: string) {
    const now = Date.now();
    if ((this.lastTyping.get(channelId) ?? 0) + 8000 > now) return;
    this.lastTyping.set(channelId, now); this.raw(Op.TYPING, { channelId });
  }
  updatePresence(presence: string) { this.raw(Op.PRESENCE_UPDATE, { presence }); }
  updateVoiceState(p: VoiceStateUpdatePayload) { this.raw(Op.VOICE_STATE_UPDATE, p); }
  requestMembers(p: { guildId: string; query?: string; userIds?: string[]; limit?: number; after?: string; nonce?: string }) { this.raw(Op.REQUEST_MEMBERS, p); }
}

class NullGateway implements GatewayLike {
  status: GatewayStatus = 'idle';
  connect() {} disconnect() {} on() { return () => {}; } onStatus() { return () => {}; }
  sendTyping() {} updatePresence() {} updateVoiceState() {}
}

let gw: GatewayLike = new GatewayClient();
export const gateway = {
  get: () => gw,
  set: (g: GatewayLike) => { gw = g; },
  useNull: () => { gw = new NullGateway(); },
};
export const getGateway = () => gw;
