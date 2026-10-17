import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import type { Ctx } from '../ctx';

/**
 * LiveKit signalling endpoint handed to browsers, and an optional same-origin proxy for it.
 *
 *   LIVEKIT_URL=auto            -> clients connect to ws(s)://<the host they used for the app>/livekit  (the server proxies to LIVEKIT_API_URL)
 *   LIVEKIT_URL=ws://localhost:7880 (or 127.0.0.1) and the app is opened via another host (LAN IP, hostname)
 *                               -> the loopback host is swapped for the host the browser used, same port
 *   anything else               -> returned unchanged (e.g. wss://livekit.example.com)
 *
 * Only signalling is proxied (one port for the browser); media still flows over LiveKit's UDP/TCP ports.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase()) || host.toLowerCase().endsWith('.localhost');
export const isAutoUrl = (u: string | undefined | null) => !u || u.trim() === '' || u.trim().toLowerCase() === 'auto';

/** Host (with port) the browser used to reach this server, honouring TRUST_PROXY's forwarded headers. */
function requestHost(req: Pick<FastifyRequest, 'host' | 'headers'>, publicUrl: string): string {
  const h = (req as any).host || req.headers.host;
  if (typeof h === 'string' && h) return h;
  try { return new URL(publicUrl).host; } catch { return 'localhost:3000'; }
}

export function resolveLivekitUrl(configured: string, req: Pick<FastifyRequest, 'host' | 'headers' | 'protocol'>, publicUrl: string): string {
  const secure = (req as any).protocol === 'https';
  const host = requestHost(req, publicUrl);
  if (isAutoUrl(configured)) return `${secure ? 'wss' : 'ws'}://${host}/livekit`;
  let u: URL;
  try { u = new URL(configured.replace(/^ws(s?):/i, 'http$1:')); } catch { return configured; }
  const reqHostname = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '[$1]');
  if (isLoopback(u.hostname) && !isLoopback(reqHostname)) {
    const proto = /^wss?:/i.test(configured) ? configured.slice(0, configured.indexOf(':')) : 'ws';
    return `${proto}://${reqHostname}${u.port ? ':' + u.port : ''}${u.pathname === '/' ? '' : u.pathname}`;
  }
  return configured;
}

/** Origins (ws/wss/http/https) the web client may connect to for LiveKit signalling: used for CSP connect-src. */
export function livekitConnectSources(configured: string): string[] {
  if (isAutoUrl(configured)) return [];
  try {
    const u = new URL(configured.replace(/^ws(s?):/i, 'http$1:'));
    const out = [`ws://${u.host}`, `wss://${u.host}`, `http://${u.host}`, `https://${u.host}`];
    return out;
  } catch { return []; }
}

const httpBase = (u: string) => u.replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');
const wsBase = (u: string) => u.replace(/^http(s?):/i, 'ws$1:').replace(/\/+$/, '');
/** Only signalling paths are reachable through the proxy (never LiveKit's admin/Twirp API). */
const ALLOWED = /^\/(rtc(\/.*)?)?$/;

export function livekitProxyRoutes(app: FastifyInstance, ctx: Ctx) {
  const upstream = () => ctx.config.livekit.apiUrl;
  const split = (url: string) => { const q = url.indexOf('?'); const path = (q < 0 ? url : url.slice(0, q)).replace(/^\/livekit/, '') || '/'; return { path, query: q < 0 ? '' : url.slice(q) }; };

  app.route({
    method: 'GET', url: '/livekit', handler: async (req, reply) => proxyHttp(req, reply),
    wsHandler: (socket, req) => proxyWs(socket as WebSocket, req),
  });
  app.route({
    method: 'GET', url: '/livekit/*', handler: async (req, reply) => proxyHttp(req, reply),
    wsHandler: (socket, req) => proxyWs(socket as WebSocket, req),
  });

  async function proxyHttp(req: FastifyRequest, reply: import('fastify').FastifyReply) {
    const { path, query } = split(req.url);
    if (!ALLOWED.test(path)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found' });
    try {
      const r = await fetch(httpBase(upstream()) + path + query, { headers: req.headers.authorization ? { authorization: String(req.headers.authorization) } : {}, signal: AbortSignal.timeout(8000) });
      const body = Buffer.from(await r.arrayBuffer());
      return reply.code(r.status).header('content-type', r.headers.get('content-type') ?? 'text/plain').header('cache-control', 'no-store').send(body);
    } catch (e) {
      req.log.warn({ err: e }, 'livekit proxy: upstream unreachable');
      return reply.code(502).send({ code: 'LIVEKIT_UNREACHABLE', message: 'The voice server (LiveKit) is not reachable from the API server' });
    }
  }

  function proxyWs(client: WebSocket, req: FastifyRequest) {
    const { path, query } = split(req.url);
    if (!ALLOWED.test(path)) { client.close(1008, 'not found'); return; }
    const up = new WebSocket(wsBase(upstream()) + path + query, { perMessageDeflate: false, handshakeTimeout: 8000 });
    const pending: { data: WebSocket.RawData; binary: boolean }[] = [];
    let open = false;
    const kill = (code = 1011, reason = '') => { try { client.close(code, reason.slice(0, 100)); } catch { /* closed */ } try { up.terminate(); } catch { /* closed */ } };
    up.on('open', () => { open = true; for (const m of pending.splice(0)) up.send(m.data, { binary: m.binary }); });
    up.on('message', (data, binary) => { if (client.readyState === 1) client.send(data, { binary }); });
    up.on('close', (code, reason) => { try { client.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011, reason.toString().slice(0, 100)); } catch { /* closed */ } });
    up.on('unexpected-response', (_rq, res) => { req.log.warn({ status: res.statusCode }, 'livekit proxy: upstream rejected the websocket'); kill(1011, `upstream ${res.statusCode}`); });
    up.on('error', (e) => { req.log.warn({ err: e }, 'livekit proxy: upstream websocket error'); kill(1011, 'upstream unreachable'); });
    client.on('message', (data, binary) => { if (open) up.send(data, { binary }); else if (pending.length < 64) pending.push({ data, binary }); });
    client.on('close', () => { try { up.close(); } catch { /* closed */ } setTimeout(() => { try { up.terminate(); } catch { /* closed */ } }, 1000).unref(); });
    client.on('error', () => kill());
  }
}
