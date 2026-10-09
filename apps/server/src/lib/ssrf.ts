import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    const hexMapped = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) { const n = (parseInt(hexMapped[1]!, 16) << 16) | parseInt(hexMapped[2]!, 16); return isPrivateIp([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.')); }
    return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b') || l.startsWith('2001:db8');
  }
  return true;
}

/** dns lookup that refuses private addresses: validation happens on the address actually connected to (no rebinding gap). */
export function safeLookup(allowPrivate = false): net.LookupFunction {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...(options as object), all: true }, (err, addrs) => {
      if (err) return (cb as any)(err);
      const list = (addrs as dns.LookupAddress[]).filter((a) => allowPrivate || !isPrivateIp(a.address));
      if (!list.length) return (cb as any)(new Error('SSRF_BLOCKED'));
      if ((options as any)?.all) return (cb as any)(null, list);
      (cb as any)(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface SafeFetchResult { status: number; headers: http.IncomingHttpHeaders; body: Buffer; url: string }

/** Minimal SSRF-safe GET: http(s) only, standard ports, validated redirects, size/time caps. */
export async function safeGet(rawUrl: string, opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; allowPrivate?: boolean } = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000, timeoutMs = opts.timeoutMs ?? 5000;
  let url = new URL(rawUrl);
  for (let i = 0; i <= (opts.maxRedirects ?? 3); i++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SSRF_BLOCKED');
    if (url.username || url.password) throw new Error('SSRF_BLOCKED');
    if (!opts.allowPrivate) {
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      if (![80, 443, 8080, 8443].includes(port)) throw new Error('SSRF_BLOCKED');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && isPrivateIp(host)) throw new Error('SSRF_BLOCKED');
    }
    const res = await new Promise<SafeFetchResult & { location?: string }>((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, { method: 'GET', lookup: safeLookup(opts.allowPrivate), timeout: timeoutMs, headers: { 'user-agent': 'JorcordBot/1.0 (+link preview)', accept: 'text/html,*/*;q=0.5' } }, (r) => {
        const chunks: Buffer[] = []; let n = 0;
        r.on('data', (c: Buffer) => { n += c.length; if (n > maxBytes) { r.destroy(); resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks), url: url.href }); } else chunks.push(c); });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks), url: url.href, location: r.headers.location }));
        r.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject); req.end();
    });
    if (res.status >= 300 && res.status < 400 && res.location) { url = new URL(res.location, url); continue; }
    return res;
  }
  throw new Error('too many redirects');
}
