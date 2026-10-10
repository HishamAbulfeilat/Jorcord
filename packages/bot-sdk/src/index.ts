/**
 * @jorcord/bot-sdk: a deliberately tiny bot toolkit.
 *   - Rest: fetch wrapper with `Bot` auth and 429 retry
 *   - Bot:  gateway client (heartbeat, resume, backoff reconnect), slash command registration, interaction handlers
 * Needs a runtime with global `fetch` and `WebSocket` (Node 22+, Bun, Deno, browsers).
 */
import { Intents, InteractionCallbackType as CB, InteractionType as IT, MessageFlags, Op, type ApplicationCommand, type EventName, type Events, type Interaction } from '@jorcord/shared';
export { Intents, MessageFlags };

export class RestError extends Error {
  constructor(public status: number, public body: any, public path: string) { super(`${status} ${body?.code ?? ''} ${body?.message ?? ''} (${path})`.trim()); }
}

export class Rest {
  constructor(public baseUrl: string, private token: string | null) {}
  /** JSON request against /api/v1. Retries a 429 (honouring retry-after) up to 3 times. 204 resolves to null. */
  async request<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.token && opts.auth !== false ? { authorization: `Bot ${this.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 3) { await sleep(Math.max(1, Number(res.headers.get('retry-after') ?? 1)) * 1000); continue; }
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (!res.ok) throw new RestError(res.status, json, path);
      return json as T;
    }
  }
  get = <T = any>(path: string) => this.request<T>('GET', path);
  post = <T = any>(path: string, body?: unknown) => this.request<T>('POST', path, body ?? {});
  put = <T = any>(path: string, body?: unknown) => this.request<T>('PUT', path, body ?? {});
  patch = <T = any>(path: string, body?: unknown) => this.request<T>('PATCH', path, body ?? {});
  delete = <T = any>(path: string) => this.request<T>('DELETE', path);
  sendMessage(channelId: string, content: string | { content?: string; components?: unknown[]; poll?: unknown }) {
    return this.post(`/channels/${channelId}/messages`, typeof content === 'string' ? { content } : content);
  }
}

export interface SlashCommand { name: string; description: string; type?: 1 | 2 | 3; options?: unknown[]; defaultMemberPermissions?: string | null; dmPermission?: boolean }
export interface BotOptions {
  token: string; baseUrl: string;
  /** Gateway intents bitfield. Omit for the legacy unfiltered stream. */
  intents?: number;
  /** Replace the WebSocket implementation (tests, older runtimes). */
  WebSocket?: typeof WebSocket;
  /** Reconnect backoff bounds in ms. */
  backoff?: { min: number; max: number };
}

/** Wraps an INTERACTION_CREATE with the reply helpers. */
export class InteractionContext {
  constructor(public raw: Interaction, private rest: Rest) {}
  get id() { return this.raw.id; }
  get name(): string | undefined { return this.raw.data?.name; }
  get customId(): string | undefined { return this.raw.data?.customId; }
  get values(): string[] { return this.raw.data?.values ?? []; }
  get userId() { return this.raw.user.id; }
  /** Value of a top-level slash command option. */
  option<T extends string | number | boolean = string>(name: string): T | undefined { return this.raw.data?.options?.find((o) => o.name === name)?.value as T | undefined; }
  private cb(type: number, data?: unknown) { return this.rest.request('POST', `/interactions/${this.raw.id}/${this.raw.token}/callback`, { type, ...(data ? { data } : {}) }, { auth: false }); }
  private msg(m: string | { content?: string; components?: unknown[] }, ephemeral?: boolean) { return { ...(typeof m === 'string' ? { content: m } : m), ...(ephemeral ? { flags: MessageFlags.EPHEMERAL } : {}) }; }
  reply(m: string | { content?: string; components?: unknown[] }, o: { ephemeral?: boolean } = {}) { return this.cb(CB.CHANNEL_MESSAGE_WITH_SOURCE, this.msg(m, o.ephemeral)); }
  defer(o: { ephemeral?: boolean } = {}) { return this.cb(CB.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, o.ephemeral ? { flags: MessageFlags.EPHEMERAL } : undefined); }
  /** Component interactions: edit the message the component sits on. */
  update(m: string | { content?: string; components?: unknown[] }) { return this.cb(CB.UPDATE_MESSAGE, this.msg(m)); }
  deferUpdate() { return this.cb(CB.DEFERRED_UPDATE_MESSAGE); }
  showModal(modal: unknown) { return this.cb(CB.MODAL, modal); }
  autocomplete(choices: { name: string; value: string | number }[]) { return this.cb(CB.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, { choices }); }
  followUp(m: string | { content?: string; components?: unknown[] }, o: { ephemeral?: boolean } = {}) { return this.rest.request('POST', `/interactions/${this.raw.id}/${this.raw.token}/messages`, this.msg(m, o.ephemeral), { auth: false }); }
  editReply(m: string | { content?: string; components?: unknown[] }) { return this.rest.request('PATCH', `/interactions/${this.raw.id}/${this.raw.token}/messages/@original`, typeof m === 'string' ? { content: m } : m, { auth: false }); }
}

type Listener<K extends EventName> = (d: Events[K]) => void | Promise<void>;
const FATAL_CLOSE = new Set([4004, 4013, 4014]); // bad/revoked token, invalid or disallowed intents: retrying cannot help

export class Bot {
  rest: Rest;
  user: Events['READY']['user'] | null = null;
  private WS: typeof WebSocket;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null; private seq = 0;
  private hb: ReturnType<typeof setInterval> | null = null; private acked = true;
  private stopped = false; private attempt = 0; private retry: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Map<string, Set<(d: any) => unknown>>();
  private commandHandlers = new Map<string, (ix: InteractionContext) => unknown>();
  private componentHandlers = new Map<string, (ix: InteractionContext) => unknown>();
  private modalHandlers = new Map<string, (ix: InteractionContext) => unknown>();
  private readyWaiter: { res: () => void; rej: (e: Error) => void } | null = null;
  private appId: string | null = null;

  constructor(public opts: BotOptions) {
    this.rest = new Rest(opts.baseUrl.replace(/\/$/, ''), opts.token);
    this.WS = opts.WebSocket ?? (globalThis as any).WebSocket;
    if (!this.WS) throw new Error('No global WebSocket: pass opts.WebSocket');
    this.on('INTERACTION_CREATE', (d) => this.dispatchInteraction(d));
  }

  // ---- events ----
  on<K extends EventName>(t: K, fn: Listener<K>): this;
  on(t: 'fatal' | 'reconnecting' | 'error', fn: (d: any) => void): this;
  on(t: string, fn: (d: any) => unknown): this { (this.listeners.get(t) ?? this.listeners.set(t, new Set()).get(t)!).add(fn); return this; }
  private emit(t: string, d: unknown) {
    for (const fn of this.listeners.get(t) ?? []) { try { const r = fn(d); if (r instanceof Promise) r.catch((e) => this.emit('error', e)); } catch (e) { if (t !== 'error') this.emit('error', e); } }
  }

  // ---- slash commands & interactions ----
  /** Handles `/name` (and user/message commands of that name). */
  command(name: string, fn: (ix: InteractionContext) => unknown) { this.commandHandlers.set(name, fn); return this; }
  component(customId: string, fn: (ix: InteractionContext) => unknown) { this.componentHandlers.set(customId, fn); return this; }
  modal(customId: string, fn: (ix: InteractionContext) => unknown) { this.modalHandlers.set(customId, fn); return this; }
  private dispatchInteraction(raw: Interaction) {
    const ix = new InteractionContext(raw, this.rest);
    const h = raw.type === IT.APPLICATION_COMMAND || raw.type === IT.APPLICATION_COMMAND_AUTOCOMPLETE ? this.commandHandlers.get(raw.data?.name ?? '')
      : raw.type === IT.MESSAGE_COMPONENT ? this.componentHandlers.get(raw.data?.customId ?? '') : raw.type === IT.MODAL_SUBMIT ? this.modalHandlers.get(raw.data?.customId ?? '') : undefined;
    if (!h) return;
    Promise.resolve().then(() => h(ix)).catch((e) => this.emit('error', e));
  }
  async applicationId(): Promise<string> { return (this.appId ??= (await this.rest.get<{ id: string }>('/applications/@me')).id); }
  /** Bulk-overwrite this bot's commands (global, or for one guild it is installed in). Idempotent. */
  async registerCommands(commands: SlashCommand[], o: { guildId?: string } = {}): Promise<ApplicationCommand[]> {
    const app = await this.applicationId();
    return this.rest.put(o.guildId ? `/applications/${app}/guilds/${o.guildId}/commands` : `/applications/${app}/commands`, commands);
  }

  // ---- gateway ----
  /** Validates the token over REST, connects to the gateway and resolves on READY. Rejects on a fatal auth/intents error. */
  async login(): Promise<this> {
    this.stopped = false;
    this.user = (await this.rest.get('/users/@me')) as any;
    const ready = new Promise<void>((res, rej) => { this.readyWaiter = { res, rej }; });
    this.connect();
    await ready;
    return this;
  }
  destroy() { this.stopped = true; if (this.retry) clearTimeout(this.retry); this.stopHeartbeat(); this.ws?.close(1000); this.ws = null; this.readyWaiter?.rej(new Error('destroyed')); this.readyWaiter = null; }

  private connect() {
    const url = this.opts.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/gateway';
    const ws = new this.WS(url); this.ws = ws;
    ws.onmessage = (e: MessageEvent) => this.onFrame(ws, JSON.parse(String(e.data)));
    ws.onclose = (e: CloseEvent) => this.onClose(ws, e.code);
    ws.onerror = () => { /* followed by close */ };
  }
  private send(ws: WebSocket, f: object) { if (ws.readyState === 1) ws.send(JSON.stringify(f)); }
  private onFrame(ws: WebSocket, f: { op: number; t?: string; s?: number; d?: any }) {
    if (ws !== this.ws) return;
    if (typeof f.s === 'number') this.seq = f.s;
    if (f.op === Op.HELLO) {
      this.startHeartbeat(ws, f.d.heartbeatInterval);
      const token = `Bot ${this.opts.token}`;
      if (this.sessionId) this.send(ws, { op: Op.RESUME, d: { token, sessionId: this.sessionId, seq: this.seq } });
      else this.send(ws, { op: Op.IDENTIFY, d: { token, ...(this.opts.intents !== undefined ? { intents: this.opts.intents } : {}) } });
    } else if (f.op === Op.HEARTBEAT_ACK) this.acked = true;
    else if (f.op === Op.RECONNECT) { this.sessionId = null; this.seq = 0; ws.close(4000); }
    else if (f.op === Op.DISPATCH && f.t) {
      if (f.t === 'READY') { this.sessionId = f.d.sessionId; this.user = f.d.user; this.attempt = 0; this.readyWaiter?.res(); this.readyWaiter = null; }
      if (f.t === 'RESUMED') this.attempt = 0;
      this.emit(f.t, f.d);
    }
  }
  private startHeartbeat(ws: WebSocket, ms: number) {
    this.stopHeartbeat(); this.acked = true;
    this.hb = setInterval(() => {
      if (!this.acked) return ws.close(4009); // zombie connection: reconnect
      this.acked = false; this.send(ws, { op: Op.HEARTBEAT });
    }, ms);
  }
  private stopHeartbeat() { if (this.hb) clearInterval(this.hb); this.hb = null; }
  private onClose(ws: WebSocket, code: number) {
    if (ws !== this.ws) return;
    this.stopHeartbeat(); this.ws = null;
    if (this.stopped) return;
    if (FATAL_CLOSE.has(code)) {
      const err = new Error(`gateway closed ${code}`); this.stopped = true;
      if (this.readyWaiter) { this.readyWaiter.rej(err); this.readyWaiter = null; } else this.emit('fatal', err);
      return;
    }
    if (code === 4007) { this.sessionId = null; this.seq = 0; } // server forgot the session: identify afresh
    const { min, max } = this.opts.backoff ?? { min: 500, max: 30_000 };
    const wait = Math.min(max, min * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.emit('reconnecting', { code, inMs: Math.round(wait) });
    this.retry = setTimeout(() => this.connect(), wait);
  }
  /** Test hook: drop the socket without destroying the bot (it will resume). */
  _dropConnection() { this.ws?.close(4000); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return { message: t.slice(0, 200) }; } };
