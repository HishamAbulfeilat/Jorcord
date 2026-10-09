/** jorcord:// deep links (and https universal/app links). Pure parsing + routing; side effects live in lib/native.ts. */
import { normalizeServerUrl } from './server';

export type DeepLink =
  | { kind: 'invite'; code: string; server?: string }
  | { kind: 'channel'; guildId: string; channelId?: string; server?: string }
  | { kind: 'open'; server?: string };

const CODE = /^[A-Za-z0-9_-]{3,64}$/;

export function parseDeepLink(raw: string): DeepLink | null {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^([a-z][a-z0-9+.-]*):(?:\/\/)?(.*)$/i); if (!m) return null;
  const scheme = m[1]!.toLowerCase(); let rest = m[2]!;
  let server: string | undefined;
  let path: string; let query = '';
  if (scheme === 'jorcord') {
    const q = rest.indexOf('?'); if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
    rest = rest.split('#')[0]!;
    path = '/' + rest.replace(/^\/+/, '');
  } else if (scheme === 'https' || scheme === 'http') {
    let u: URL; try { u = new URL(raw); } catch { return null; }
    server = u.origin; path = u.pathname; query = u.search.replace(/^\?/, '');
  } else return null;
  const params = new URLSearchParams(query);
  const qs = params.get('server'); if (qs) { const n = normalizeServerUrl(qs); if (n) server = n; }
  const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (parts[0] === 'invite' && parts[1] && CODE.test(parts[1])) return { kind: 'invite', code: parts[1], server };
  if (parts[0] === 'channels' && parts[1] && /^(\d+|@me)$/.test(parts[1])) return { kind: 'channel', guildId: parts[1], channelId: /^\d+$/.test(parts[2] ?? '') ? parts[2] : undefined, server };
  if (scheme === 'jorcord' && (parts[0] === 'open' || parts.length === 0)) return { kind: 'open', server };
  return null;
}

export function routeFor(l: DeepLink): string {
  switch (l.kind) {
    case 'invite': return `/invite/${l.code}`;
    case 'channel': return `/channels/${l.guildId}${l.channelId ? '/' + l.channelId : ''}`;
    default: return '/channels/@me';
  }
}
