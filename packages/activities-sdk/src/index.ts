/**
 * @jorcord/activities-sdk: the Embedded App SDK for Jorcord activities.
 *
 * An activity is a web page you host (https) that Jorcord shows in a sandboxed iframe inside a voice channel.
 * This package is the page's side of a small `postMessage` protocol; it has no dependencies and runs in any browser.
 *
 *   import { JorcordActivity } from '@jorcord/activities-sdk';
 *   const activity = new JorcordActivity();
 *   const { instance, user, participants } = await activity.ready();
 *   activity.subscribe('VOICE_STATE_UPDATE', (p) => console.log('participants', p));
 *   await activity.setState({ clicks: 1 });
 *
 * Protocol (also implemented by the host in apps/web/src/lib/activityHost.ts and mirrored in @jorcord/shared as ACTIVITY_PROTOCOL):
 *   activity -> host  { source: 'jorcord-activity', v: 1, type: 'GET_PARTICIPANTS', id: 7, payload?: any }
 *   host -> activity  { source: 'jorcord-activity', v: 1, type: 'RESPONSE', id: 7, ok: true, payload } | { ..., ok: false, error }
 *   host -> activity  { source: 'jorcord-activity', v: 1, type: 'EVENT', event: 'VOICE_STATE_UPDATE', payload }
 * Only messages whose `source` is the parent window and whose origin is the host origin (passed as `?jorcord_host=` by Jorcord) are accepted.
 */

export const PROTOCOL = {
  source: 'jorcord-activity',
  version: 1,
  requests: ['READY', 'GET_INSTANCE', 'GET_PARTICIPANTS', 'GET_USER', 'SUBSCRIBE', 'UNSUBSCRIBE', 'SET_STATE', 'CLOSE'],
  subscriptions: ['VOICE_STATE_UPDATE', 'ACTIVITY_UPDATE', 'PARTICIPANTS_UPDATE'],
} as const;

export type Subscription = (typeof PROTOCOL.subscriptions)[number];
export interface Participant { id: string; username: string; displayName: string | null; avatar: string | null; selfMute: boolean; selfDeaf: boolean }
export interface Instance { id: string; applicationId: string; channelId: string; guildId: string | null; hostId: string; state: unknown; startedAt: string }
export interface ActivityUser { id: string; username: string; displayName: string | null; avatar: string | null }
export interface ReadyResult { instance: Instance; user: ActivityUser; participants: Participant[] }

/** The slice of `window` the SDK needs, so it can be driven by tests or a non-browser host. */
export interface Transport {
  /** the window the host lives in (normally `window.parent`) */ target: { postMessage(message: unknown, targetOrigin: string): void };
  /** receive raw message events */ listen(handler: (e: { data: unknown; origin: string; source: unknown }) => void): () => void;
  /** identity of the host window, to reject messages from anything else */ hostWindow: unknown;
}

export interface Options {
  /** Origin of the Jorcord host. Defaults to the `jorcord_host` query parameter Jorcord adds to the activity URL. */
  hostOrigin?: string;
  transport?: Transport;
  /** ms before a request without an answer rejects. Default 10000. */
  timeoutMs?: number;
}

export class ActivityError extends Error {
  constructor(message: string, public code = 'ACTIVITY_ERROR') { super(message); }
}

function originFromQuery(): string | null {
  try {
    const raw = new URL(globalThis.location?.href ?? '').searchParams.get('jorcord_host');
    return raw ? new URL(raw).origin : null;
  } catch { return null; }
}

function browserTransport(): Transport {
  const w = globalThis as unknown as Window;
  return {
    target: w.parent, hostWindow: w.parent,
    listen: (h) => { const fn = (e: MessageEvent) => h({ data: e.data, origin: e.origin, source: e.source }); w.addEventListener('message', fn); return () => w.removeEventListener('message', fn); },
  };
}

export class JorcordActivity {
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private subs = new Map<string, Set<(payload: any) => void>>();
  private off: (() => void) | null = null;
  private readonly hostOrigin: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readyResult: Promise<ReadyResult> | null = null;

  constructor(opts: Options = {}) {
    const origin = opts.hostOrigin ?? originFromQuery();
    if (!origin) throw new ActivityError('Missing host origin: open this page from Jorcord (it adds ?jorcord_host=...) or pass hostOrigin', 'NO_HOST');
    this.hostOrigin = origin;
    this.transport = opts.transport ?? browserTransport();
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.off = this.transport.listen((e) => this.onMessage(e));
  }

  private onMessage(e: { data: unknown; origin: string; source: unknown }) {
    if (e.source !== this.transport.hostWindow || e.origin !== this.hostOrigin) return; // only our host, never a sibling frame or a navigated-away parent
    const m = e.data as { source?: string; v?: number; type?: string; id?: number; ok?: boolean; payload?: unknown; error?: string; code?: string; event?: string } | null;
    if (!m || typeof m !== 'object' || m.source !== PROTOCOL.source || m.v !== PROTOCOL.version) return;
    if (m.type === 'RESPONSE' && typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok) p.res(m.payload); else p.rej(new ActivityError(m.error ?? 'Request failed', m.code));
    } else if (m.type === 'EVENT' && typeof m.event === 'string') {
      for (const fn of this.subs.get(m.event) ?? []) { try { fn(m.payload); } catch { /* a handler's bug must not break the others */ } }
    }
  }

  private request<T>(type: (typeof PROTOCOL.requests)[number], payload?: unknown): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new ActivityError(`${type} timed out`, 'TIMEOUT')); }, this.timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.transport.target.postMessage({ source: PROTOCOL.source, v: PROTOCOL.version, type, id, ...(payload !== undefined ? { payload } : {}) }, this.hostOrigin);
    });
  }

  /** Tells the host the page is ready and resolves with the launch context. Call once, before anything else. */
  ready(): Promise<ReadyResult> { return (this.readyResult ??= this.request<ReadyResult>('READY')); }
  getInstance(): Promise<Instance> { return this.request('GET_INSTANCE'); }
  /** Members connected to the voice channel right now. */
  getParticipants(): Promise<Participant[]> { return this.request('GET_PARTICIPANTS'); }
  /** The viewing user. */
  getUser(): Promise<ActivityUser> { return this.request('GET_USER'); }
  /** Replaces the shared state of this activity instance (JSON, at most 4096 bytes serialized; last writer wins). Everybody in the call receives ACTIVITY_UPDATE. */
  setState(state: unknown): Promise<Instance> { return this.request('SET_STATE', { state }); }
  /** Subscribe to host events. Returns an unsubscribe function. */
  subscribe(event: Subscription, handler: (payload: any) => void): () => void {
    if (!PROTOCOL.subscriptions.includes(event)) throw new ActivityError(`Unknown event ${event}`, 'BAD_EVENT');
    let set = this.subs.get(event);
    if (!set) { set = new Set(); this.subs.set(event, set); void this.request('SUBSCRIBE', { event }).catch(() => {}); }
    set.add(handler);
    return () => {
      const s = this.subs.get(event);
      if (!s?.delete(handler) || s.size) return;
      this.subs.delete(event);
      void this.request('UNSUBSCRIBE', { event }).catch(() => {});
    };
  }
  /** Ask the host to close the activity for this user. */
  close(): Promise<void> { return this.request('CLOSE'); }
  /** Stop listening; pending requests reject. */
  destroy() {
    this.off?.(); this.off = null;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.rej(new ActivityError('destroyed', 'DESTROYED')); this.pending.delete(id); }
    this.subs.clear();
  }
}
