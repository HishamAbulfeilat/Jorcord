/** Gateway client: HELLO -> IDENTIFY/RESUME, heartbeat w/ ack watchdog, exponential reconnect, typed events. Swappable via `GatewayLike`. */
import { gatewayUrl } from './server';
import { Op, type EventName, type Events, type GatewayFrame, type VoiceStateUpdatePayload } from '@jorcord/shared';

export type GatewayStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
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

  constructor(private urlOverride?: string) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { if (!this.manual && this.status !== 'connected') this.open(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.manual && this.token && (!this.ws || this.ws.readyState > 1)) this.open();
      });
    }
  }

  on<K extends EventName>(event: K, fn: (d: Events[K]) => void) {
    let s = this.handlers.get(event); if (!s) this.handlers.set(event, (s = new Set()));
    s.add(fn); return () => { s!.delete(fn); };
  }
  onStatus(fn: (s: GatewayStatus) => void) { this.statusHandlers.add(fn); return () => { this.statusHandlers.delete(fn); }; }
  private setStatus(s: GatewayStatus) { this.status = s; this.statusHandlers.forEach((f) => f(s)); }
  private emit(t: string, d: unknown) { this.handlers.get(t)?.forEach((f) => { try { f(d); } catch (e) { console.error('[gateway] handler error', t, e); } }); this.handlers.get('*')?.forEach((f) => f({ t, d })); }

  connect(token: string) { this.token = token; this.manual = false; this.sessionId = null; this.seq = 0; this.open(); }
  disconnect() {
    this.manual = true; this.cleanup(); this.sessionId = null; this.token = '';
    try { this.ws?.close(1000); } catch { /* noop */ }
    this.ws = null; this.setStatus('closed');
  }
  private cleanup() {
    if (this.hbTimer) clearInterval(this.hbTimer); this.hbTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
  }
  private open() {
    this.cleanup();
    if (this.ws && this.ws.readyState <= 1) { try { this.ws.close(); } catch { /* noop */ } }
    this.setStatus(this.retry > 0 || this.sessionId ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.urlOverride ?? gatewayUrl()); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onmessage = (ev) => { try { this.onFrame(JSON.parse(String(ev.data))); } catch (e) { console.error('[gateway] bad frame', e); } };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.cleanup();
      if (this.manual) return;
      if (ev.code === 4004 || ev.code === 4001) { this.authFailed?.(); return; }
      if (ev.code === 4009 || ev.code === 4007) { this.sessionId = null; this.seq = 0; }
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* close follows */ };
  }
  authFailed?: () => void;
  getToken?: () => string | null;
  /** Re-open after auth was repaired (token refreshed). */
  reconnect(token: string) { this.token = token; this.manual = false; this.open(); }

  private scheduleReconnect() {
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
        this.hbTimer = setInterval(() => {
          if (this.ackPending) { try { this.ws?.close(4000); } catch { /* noop */ } return; }
          this.ackPending = true; this.raw(Op.HEARTBEAT, this.seq);
        }, interval);
        if (this.sessionId) this.raw(Op.RESUME, { token: this.getToken?.() ?? this.token, sessionId: this.sessionId, seq: this.seq });
        else this.raw(Op.IDENTIFY, { token: this.getToken?.() ?? this.token, properties: { os: navigator.platform, client: 'jorcord-web' } });
        break;
      }
      case Op.HEARTBEAT: this.raw(Op.HEARTBEAT, this.seq); break;
      case Op.HEARTBEAT_ACK: this.ackPending = false; break;
      case Op.RECONNECT: try { this.ws?.close(4000); } catch { /* noop */ } break;
      case Op.DISPATCH: {
        if (f.t === 'READY') { this.sessionId = f.d.sessionId; this.retry = 0; this.setStatus('connected'); }
        else if (f.t === 'RESUMED') { this.retry = 0; this.setStatus('connected'); }
        if (f.t) this.emit(f.t, f.d);
        break;
      }
    }
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
