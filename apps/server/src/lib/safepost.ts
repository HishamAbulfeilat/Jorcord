import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isPrivateIp, safeLookup } from './ssrf';

export interface SafePostResult { status: number; body: string }
/**
 * SSRF-safe JSON POST (interactions endpoint delivery). http(s) only, no credentials in the URL, no redirects (a redirect is a failure),
 * connect-time private-address blocking via safeLookup, response capped at 64 KiB, hard deadline.
 */
export async function safePost(rawUrl: string, body: string, headers: Record<string, string>, opts: { timeoutMs?: number; allowPrivate?: boolean } = {}): Promise<SafePostResult> {
  const url = new URL(rawUrl), timeoutMs = opts.timeoutMs ?? 3000;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SSRF_BLOCKED');
  if (url.username || url.password) throw new Error('SSRF_BLOCKED');
  if (!opts.allowPrivate) {
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (![80, 443, 8080, 8443].includes(port)) throw new Error('SSRF_BLOCKED'); // no port scanning of public hosts via the interactions endpoint
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) throw new Error('SSRF_BLOCKED');
  }
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'POST', lookup: safeLookup(opts.allowPrivate), timeout: timeoutMs, headers: { 'content-type': 'application/json', 'user-agent': 'Jorcord-Interactions/1.0', 'content-length': String(Buffer.byteLength(body)), ...headers } }, (r) => {
      const chunks: Buffer[] = []; let n = 0;
      r.on('data', (c: Buffer) => { n += c.length; if (n > 65536) { r.destroy(); reject(new Error('response too large')); } else chunks.push(c); });
      r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    const hard = setTimeout(() => req.destroy(new Error('deadline')), timeoutMs); hard.unref();
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('close', () => clearTimeout(hard));
    req.on('error', reject); req.end(body);
  });
}
