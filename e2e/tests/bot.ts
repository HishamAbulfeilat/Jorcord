import type { Page } from '@playwright/test';
import { rest } from './helpers';

const API = 'http://127.0.0.1:3100/api/v1';
const WS = 'ws://127.0.0.1:3100/gateway';

/** A real application bot for e2e: creates the app as a user, connects to the gateway like discord.js would, answers interactions over REST. */
export class Bot {
  appId = ''; botUserId = ''; token = ''; clientSecret = '';
  private ws: any; private heartbeat?: ReturnType<typeof setInterval>;
  interactions: any[] = []; private waiters: { pred: (i: any) => boolean; res: (i: any) => void }[] = [];

  /** Create an application as the logged-in user of `page` (the same call the developer portal makes). */
  static async create(page: Page, name: string, o: { botPublic?: boolean; redirectUris?: string[] } = {}): Promise<Bot> {
    const a = await rest(page, 'POST', '/applications', { name, ...o });
    const b = new Bot(); b.appId = a.id; b.botUserId = a.botUser.id; b.token = a.token; b.clientSecret = a.clientSecret; return b;
  }
  async rest<T = any>(method: string, path: string, body?: unknown, token = this.token): Promise<T> {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bot ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }
  /** Public interaction endpoints: the interaction token is the credential. */
  async http<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
  }
  async connect(): Promise<this> {
    const WebSocketImpl = (globalThis as any).WebSocket;
    this.ws = new WebSocketImpl(WS);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bot gateway READY timeout')), 15_000);
      this.ws.onmessage = (ev: any) => {
        const f = JSON.parse(String(ev.data));
        if (f.op === 10) { this.heartbeat = setInterval(() => this.ws.send(JSON.stringify({ op: 1, d: null })), f.d.heartbeatInterval ?? 30_000); this.ws.send(JSON.stringify({ op: 2, d: { token: `Bot ${this.token}`, properties: { client: 'e2e-bot' } } })); }
        else if (f.op === 0 && f.t === 'READY') { clearTimeout(t); resolve(); }
        else if (f.op === 0 && f.t === 'INTERACTION_CREATE') { this.interactions.push(f.d); this.waiters = this.waiters.filter((w) => { if (w.pred(f.d)) { w.res(f.d); return false; } return true; }); }
      };
      this.ws.onerror = () => reject(new Error('bot gateway error'));
    });
    return this;
  }
  /** Resolves with the next (or an already received, unconsumed) interaction matching `pred`. */
  next(pred: (i: any) => boolean = () => true, timeout = 15_000): Promise<any> {
    const i = this.interactions.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.interactions.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no matching interaction within ' + timeout + 'ms')), timeout);
      this.waiters.push({ pred, res: (x) => { clearTimeout(t); this.interactions = this.interactions.filter((y) => y !== x); res(x); } });
    });
  }
  callback(i: { id: string; token: string }, type: number, data?: unknown) { return this.http('POST', `/interactions/${i.id}/${i.token}/callback`, { type, ...(data ? { data } : {}) }); }
  followup(i: { id: string; token: string }, data: unknown) { return this.http('POST', `/interactions/${i.id}/${i.token}/messages`, data); }
  editOriginal(i: { id: string; token: string }, data: unknown) { return this.http('PATCH', `/interactions/${i.id}/${i.token}/messages/@original`, data); }
  /** Install into a guild through the OAuth2 endpoint as `page`'s user (needs MANAGE_GUILD there). */
  async install(page: Page, guildId: string, permissions = '0') {
    return rest(page, 'POST', '/oauth2/authorize', { clientId: this.appId, scope: 'bot applications.commands', permissions, guildId });
  }
  close() { clearInterval(this.heartbeat); try { this.ws?.close(); } catch { /* */ } }
}
