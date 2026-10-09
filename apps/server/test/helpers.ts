import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../src/app';
import type { Ctx } from '../src/ctx';

export interface TestEnv { app: FastifyInstance; ctx: Ctx; port: number; close(): Promise<void>; dir: string }
export async function startServer(config: Record<string, unknown> = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'jorcord-test-'));
  const { app, ctx } = await buildApp({
    memoryDb: true,
    config: { logLevel: 'silent', rateLimit: false, dataDir: dir, jwtSecret: 'test-secret-test-secret-123456', unfurlOnSend: false, heartbeatIntervalMs: 30000, ...config } as any,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return { app, ctx, port, dir, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export interface Client { id: string; token: string; refresh: string; username: string; user: any }
let n = 0;
export class Api {
  constructor(public env: TestEnv) {}
  async req(method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.env.app.inject({
      method: method as any, url: `/api/v1${url}`, payload: body === undefined ? undefined : (body as any),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let json: any = null; try { json = res.json(); } catch { /* empty */ }
    return { status: res.statusCode, body: json, raw: res };
  }
  async register(name?: string): Promise<Client> {
    const username = (name ?? 'user') + (++n) + 'x';
    const r = await this.req('POST', '/auth/register', null, { email: `${username}@example.com`, username, password: 'correct horse battery' });
    if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.body));
    return { id: r.body.user.id, token: r.body.accessToken, refresh: r.body.refreshToken, username, user: r.body.user };
  }
}

export class WsClient {
  ws!: WebSocket; frames: any[] = []; sessionId = ''; lastSeq = 0; closed: { code: number } | null = null;
  private waiters: { pred: (f: any) => boolean; res: (f: any) => void }[] = [];
  static async connect(port: number): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
    c.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()); c.frames.push(f);
      if (typeof f.s === 'number') c.lastSeq = f.s;
      if (f.t === 'READY') c.sessionId = f.d.sessionId;
      for (const w of [...c.waiters]) if (w.pred(f)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.res(f); }
    });
    c.ws.on('close', (code) => { c.closed = { code }; });
    await new Promise<void>((res, rej) => { c.ws.once('open', () => res()); c.ws.once('error', rej); });
    return c;
  }
  send(f: object) { this.ws.send(JSON.stringify(f)); }
  /** Resolve with the first frame (already received or future) matching pred. */
  waitFor(pred: (f: any) => boolean, ms = 5000): Promise<any> {
    const hit = this.frames.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for frame; got ' + JSON.stringify(this.frames.map((f) => f.t ?? f.op)))), ms);
      this.waiters.push({ pred, res: (f) => { clearTimeout(t); res(f); } });
    });
  }
  waitEvent(t: string, pred: (d: any) => boolean = () => true, ms = 5000) { return this.waitFor((f) => f.t === t && pred(f.d), ms); }
  /** Assert no matching frame arrives within ms. */
  async expectNone(pred: (f: any) => boolean, ms = 300) { await new Promise((r) => setTimeout(r, ms)); if (this.frames.some(pred)) throw new Error('unexpected frame'); }
  async identify(token: string) { await this.waitFor((f) => f.op === 10); this.send({ op: 2, d: { token } }); return this.waitEvent('READY'); }
  waitClose(ms = 3000) { return new Promise<{ code: number }>((res, rej) => { if (this.closed) return res(this.closed); const t = setTimeout(() => rej(new Error('no close')), ms); this.ws.once('close', (code) => { clearTimeout(t); res({ code }); }); }); }
  close() { this.ws.close(); }
}
