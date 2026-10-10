/** Browser-side voice self-test shown in "Open diagnostics": each check says what is wrong and how to fix it. */
export interface DiagCheck { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string }

const httpOf = (u: string) => u.replace(/^ws(s?):/i, 'http$1:');

export function isLoopbackHost(h: string) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost'); }

export async function runDiagnostics(o: { signalUrl?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<DiagCheck[]> {
  const out: DiagCheck[] = [];
  const g: any = typeof window === 'undefined' ? {} : window;
  const nav: any = typeof navigator === 'undefined' ? {} : navigator;
  const secure = g.isSecureContext !== false;
  out.push({ id: 'secure', label: 'Secure context', status: secure ? 'ok' : 'fail', detail: secure ? 'https or localhost: microphone access is allowed.' : 'This page is not https/localhost, so the browser blocks the microphone. Serve the app over https.' });
  out.push({ id: 'webrtc', label: 'WebRTC', status: typeof g.RTCPeerConnection === 'function' ? 'ok' : 'fail', detail: typeof g.RTCPeerConnection === 'function' ? 'Supported.' : 'This browser has no WebRTC.' });
  out.push({ id: 'mic-api', label: 'Microphone API', status: nav.mediaDevices?.getUserMedia ? 'ok' : 'fail', detail: nav.mediaDevices?.getUserMedia ? 'Available.' : 'navigator.mediaDevices is missing (insecure page or unsupported browser).' });
  try {
    const p = await nav.permissions?.query?.({ name: 'microphone' });
    if (p) out.push({ id: 'mic-perm', label: 'Microphone permission', status: p.state === 'denied' ? 'fail' : p.state === 'granted' ? 'ok' : 'warn', detail: p.state === 'denied' ? 'Blocked. Allow it from the address-bar lock icon and reload.' : p.state === 'granted' ? 'Granted.' : 'Not asked yet: the browser will prompt when you join.' });
  } catch { /* Safari/Firefox may not support querying */ }
  out.push({ id: 'online', label: 'Network', status: nav.onLine === false ? 'fail' : 'ok', detail: nav.onLine === false ? 'The browser reports it is offline.' : 'Online.' });
  const url = o.signalUrl;
  if (url) {
    let host = ''; try { host = new URL(httpOf(url)).hostname; } catch { /* handled below */ }
    const mixed = g.location?.protocol === 'https:' && /^ws:/i.test(url);
    if (mixed) out.push({ id: 'mixed', label: 'Signalling URL', status: 'fail', detail: `${url} is plain ws:// but this page is https: browsers block it. Use a wss:// LIVEKIT_URL (or LIVEKIT_URL=auto).` });
    else if (host && g.location?.hostname && isLoopbackHost(host) && !isLoopbackHost(g.location.hostname)) out.push({ id: 'loopback', label: 'Signalling URL', status: 'fail', detail: `${url} points at localhost but you opened the app via ${g.location.hostname}. Set LIVEKIT_URL to an address reachable from the browser, or LIVEKIT_URL=auto.` });
    const f = o.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (f && !mixed) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : undefined; const t = setTimeout(() => ctl?.abort(), o.timeoutMs ?? 6000);
      const t0 = Date.now();
      try { await f(httpOf(url), { mode: 'no-cors', cache: 'no-store', signal: ctl?.signal }); out.push({ id: 'signal', label: 'Voice server reachable', status: 'ok', detail: `${url} answered in ${Date.now() - t0} ms.` }); }
      catch { out.push({ id: 'signal', label: 'Voice server reachable', status: 'fail', detail: `Could not reach ${url} from this browser. Is the livekit service running and its port published/proxied?` }); }
      finally { clearTimeout(t); }
    }
  }
  return out;
}

/** Plain-text report for support / bug reports. */
export function formatDiagnostics(checks: DiagCheck[], extra: Record<string, string | number | null | undefined> = {}): string {
  const lines = checks.map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') lines.push(`${k}: ${v}`);
  return lines.join('\n');
}
