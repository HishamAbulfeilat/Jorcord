import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCsp } from '../src/lib/webapp';
import { livekitConnectSources, resolveLivekitUrl } from '../src/routes/voice-livekit';
import { Api, startServer, type TestEnv } from './helpers';

const req = (host: string, protocol = 'http') => ({ host, headers: { host }, protocol }) as any;

describe('resolveLivekitUrl', () => {
  it('auto = same origin /livekit, ws or wss following the page protocol', () => {
    expect(resolveLivekitUrl('auto', req('localhost:3000'), 'http://localhost:3000')).toBe('ws://localhost:3000/livekit');
    expect(resolveLivekitUrl('auto', req('192.168.1.20:3000'), 'http://localhost:3000')).toBe('ws://192.168.1.20:3000/livekit');
    expect(resolveLivekitUrl('auto', req('chat.example.com', 'https'), 'https://chat.example.com')).toBe('wss://chat.example.com/livekit');
    expect(resolveLivekitUrl('', req('chat.example.com', 'https'), 'https://x')).toBe('wss://chat.example.com/livekit');
  });
  it('swaps a loopback LIVEKIT_URL for the host the browser used, keeping port and scheme', () => {
    expect(resolveLivekitUrl('ws://localhost:7880', req('192.168.1.20:3000'), 'http://localhost:3000')).toBe('ws://192.168.1.20:7880');
    expect(resolveLivekitUrl('ws://127.0.0.1:7880', req('myhost.lan:3000'), 'http://localhost:3000')).toBe('ws://myhost.lan:7880');
    expect(resolveLivekitUrl('wss://localhost:7443/lk', req('box.example.com:3000'), 'http://x')).toBe('wss://box.example.com:7443/lk');
  });
  it('leaves a usable URL alone', () => {
    expect(resolveLivekitUrl('ws://localhost:7880', req('localhost:3000'), 'http://localhost:3000')).toBe('ws://localhost:7880');
    expect(resolveLivekitUrl('ws://127.0.0.1:7880', req('localhost:3000'), 'http://localhost:3000')).toBe('ws://127.0.0.1:7880');
    expect(resolveLivekitUrl('wss://livekit.example.com', req('192.168.1.20:3000'), 'http://x')).toBe('wss://livekit.example.com');
  });
});

describe('CSP connect-src is derived from config, not a blanket allow', () => {
  const connect = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src '))!;
  it('allows self + same-origin ws and nothing wide open', () => {
    const c = connect(buildCsp({ host: 'localhost:3000' }));
    expect(c).toBe("connect-src 'self' ws://localhost:3000");
    expect(c).not.toMatch(/ (https?|wss?):( |$)/);
  });
  it('adds the configured LiveKit origin in all schemes, and the page host with the same port when LIVEKIT_URL is loopback', () => {
    const c = connect(buildCsp({ host: '192.168.1.20:3000', livekitConnect: livekitConnectSources('ws://localhost:7880') }));
    for (const s of ['ws://localhost:7880', 'wss://localhost:7880', 'http://localhost:7880', 'ws://192.168.1.20:7880', 'wss://192.168.1.20:7880']) expect(c).toContain(s);
    expect(connect(buildCsp({ host: 'a.example.com', secure: true, livekitConnect: livekitConnectSources('wss://lk.example.com') }))).toContain('wss://lk.example.com');
    expect(livekitConnectSources('auto')).toEqual([]);
  });
  it('rejects hostile Host headers and keeps worker/media sources for the audio worklet + blob media', () => {
    expect(connect(buildCsp({ host: "evil.com; script-src *" }))).toBe("connect-src 'self'");
    const csp = buildCsp({ host: 'localhost:3000' });
    expect(csp).toContain("worker-src 'self' blob:"); expect(csp).toContain('media-src'); expect(csp).toContain('blob:');
  });
});

describe('same-origin LiveKit signalling proxy', () => {
  let env: TestEnv; let upstream: http.Server; let wss: WebSocketServer; let web: string; const seen: string[] = [];
  beforeAll(async () => {
    upstream = http.createServer((rq, rs) => { seen.push(rq.url!); if (rq.url!.startsWith('/rtc/v1/validate')) { rs.writeHead(401, { 'content-type': 'text/plain' }); rs.end('invalid token'); } else { rs.writeHead(200, { 'content-type': 'text/plain' }); rs.end('OK'); } });
    wss = new WebSocketServer({ server: upstream });
    wss.on('connection', (s, rq) => { seen.push('ws ' + rq.url); s.on('message', (d, bin) => s.send(d, { binary: bin })); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    web = mkdtempSync(join(tmpdir(), 'jorcord-web-')); mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>x</title>');
    env = await startServer({ webDist: web, livekit: { url: 'auto', apiUrl: `http://127.0.0.1:${port}`, apiKey: 'k', apiSecret: 'secretsecretsecretsecretsecretsecret' } });
  });
  afterAll(async () => { await env.close(); wss.close(); upstream.close(); rmSync(web, { recursive: true, force: true }); });

  it('hands out the request origin as the signalling URL (any host works, no extra port)', async () => {
    const api = new Api(env); const u = await api.register('lk');
    const g = await api.req('POST', '/guilds', u.token, { name: 'LK Guild' });
    const vc = (await api.req('POST', `/guilds/${g.body.id}/channels`, u.token, { name: 'Talk', type: 'voice' })).body;
    const r = await env.app.inject({ method: 'POST', url: '/api/v1/voice/token', headers: { authorization: `Bearer ${u.token}`, host: '192.168.5.5:3000' }, payload: { channelId: vc.id } });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toBe('ws://192.168.5.5:3000/livekit');
  });
  it('proxies HTTP GETs (health, validate with the upstream status) and blocks everything but /rtc', async () => {
    const root = await env.app.inject({ url: '/livekit' }); expect(root.statusCode).toBe(200); expect(root.body).toBe('OK');
    const v = await env.app.inject({ url: '/livekit/rtc/v1/validate?access_token=x' });
    expect(v.statusCode).toBe(401); expect(v.body).toBe('invalid token');
    for (const p of ['/livekit/twirp/livekit.RoomService/ListRooms', '/livekit/debug/pprof', '/livekit/metrics']) expect((await env.app.inject({ url: p })).statusCode, p).toBe(404);
  });
  it('relays WebSocket frames both ways with the query string intact', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}/livekit/rtc/v1?access_token=abc&protocol=17`);
    const got = await new Promise<Buffer>((res, rej) => { ws.once('open', () => ws.send(Buffer.from([1, 2, 3]))); ws.once('message', (d) => res(d as Buffer)); ws.once('error', rej); setTimeout(() => rej(new Error('no echo')), 4000); });
    expect([...got]).toEqual([1, 2, 3]);
    expect(seen).toContain('ws /rtc/v1?access_token=abc&protocol=17');
    ws.close();
  });
  it('closes the client when LiveKit is down and answers 502 over HTTP', async () => {
    const down = await startServer({ livekit: { url: 'auto', apiUrl: 'http://127.0.0.1:1', apiKey: 'k', apiSecret: 'secretsecretsecretsecretsecretsecret' } });
    try {
      expect((await down.app.inject({ url: '/livekit/rtc/v1/validate' })).statusCode).toBe(502);
      const ws = new WebSocket(`ws://127.0.0.1:${down.port}/livekit/rtc/v1?access_token=a`);
      const code = await new Promise<number>((res) => { ws.once('close', (c) => res(c)); ws.once('error', () => {}); });
      expect(code).toBe(1011);
    } finally { await down.close(); }
  });
});
