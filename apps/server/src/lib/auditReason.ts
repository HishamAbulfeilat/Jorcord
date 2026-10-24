import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

/** `X-Audit-Log-Reason` (percent-encoded, at most 512 chars like Discord) of the request being handled. */
const store = new AsyncLocalStorage<{ reason: string | null }>();

/** Parses the header value: URL-decoded, control characters stripped, trimmed, capped at 512. Garbage encodings are ignored, never an error. */
export function parseAuditReason(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || !v.length || v.length > 2048) return null;
  let s: string;
  try { s = decodeURIComponent(v); } catch { return null; }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512);
  return s.length ? s : null;
}

/** The reason supplied by the current request, for the audit writer to use when a route passed none. */
export const currentAuditReason = (): string | null => store.getStore()?.reason ?? null;

/** Registers one onRequest hook that makes the header available to every audit write made while the request is handled. */
export function installAuditReason(app: FastifyInstance) {
  app.addHook('onRequest', (req, _reply, done) => {
    const reason = parseAuditReason(req.headers['x-audit-log-reason']);
    (req as { auditReason?: string | null }).auditReason = reason;
    store.run({ reason }, done);
  });
}

declare module 'fastify' { interface FastifyRequest { auditReason?: string | null } }
