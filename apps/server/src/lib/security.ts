import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';

/** pino redaction paths: credentials and database error details (which can echo submitted values). */
export const LOG_REDACT = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'res.headers["set-cookie"]',
  'err.detail', 'err.parameters', 'err.where', 'err.internalQuery',
];

/** URL as it may appear in logs: no query string (may carry tokens/PII) and no capability secrets embedded in the path. */
export function redactUrl(url: string): string {
  const path = url.split('?')[0] ?? url;
  return path
    .replace(/(\/webhooks\/\d+\/)[^/]+/, '$1[redacted]')
    .replace(/(\/files\/)[a-f0-9]{16,64}/i, '$1[redacted]');
}

export const logSerializers = {
  req(req: any) { return { method: req.method, url: redactUrl(req.url ?? ''), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }; },
};

/**
 * Helmet-equivalent response hardening for an API that returns JSON only. Routes that need different values (the file
 * download route sets its own CSP / CORP) win because we never overwrite a header that is already present.
 */
export function securityHeaders(reply: FastifyReply, req: FastifyRequest, config: Pick<Config, 'isProd'>) {
  const set = (k: string, v: string) => { if (!reply.hasHeader(k)) reply.header(k, v); };
  set('x-content-type-options', 'nosniff');
  set('referrer-policy', 'no-referrer');
  set('x-frame-options', 'DENY');
  set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  set('cross-origin-opener-policy', 'same-origin');
  set('cross-origin-resource-policy', 'same-origin');
  set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  set('x-dns-prefetch-control', 'off');
  set('x-permitted-cross-domain-policies', 'none');
  if (config.isProd && req.protocol === 'https') set('strict-transport-security', 'max-age=15552000; includeSubDomains');
  // API responses are per-user: never let a shared cache keep them (file downloads set their own immutable caching)
  if (req.url.startsWith('/api/') || req.url.startsWith('/health')) set('cache-control', 'no-store');
}
