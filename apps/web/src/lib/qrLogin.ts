/** QR-code login helpers: what goes into the code, how a scanner reads it back, and how a device is described on the confirmation prompt. */
import { getServerUrl, publicOrigin } from './server';

export interface QrLoginPayload { id: string; secret: string; server: string }

/** The text encoded in the QR code. Only the scan secret is in here; the waiting device keeps its (separate) poll secret to itself. */
export function qrPayload(code: { id: string; scanSecret: string }): string {
  const q = new URLSearchParams({ i: code.id, c: code.scanSecret, s: publicOrigin() });
  return `jorcord://qr-login?${q}`;
}

/** Parse scanned text; null when it is not a Jorcord login code. */
export function parseQrPayload(text: string): QrLoginPayload | null {
  try {
    const u = new URL(text.trim());
    if (u.protocol !== 'jorcord:' || u.hostname !== 'qr-login') return null;
    const id = u.searchParams.get('i') ?? '', secret = u.searchParams.get('c') ?? '', server = u.searchParams.get('s') ?? '';
    if (!/^\d{1,20}$/.test(id) || secret.length < 20 || secret.length > 100 || !/^[\w-]+$/.test(secret)) return null;
    return { id, secret, server };
  } catch { return null; }
}

/** The code was made for another Jorcord server than the one this app talks to. */
export function isOtherServer(p: QrLoginPayload): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase();
  return !!p.server && norm(p.server) !== norm(getServerUrl() || (typeof location !== 'undefined' ? location.origin : ''));
}

/** "Chrome on Windows" from a user-agent string. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'an unknown device';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux|X11/i.test(ua) ? 'Linux' : '';
  const app = /Tauri|Jorcord/i.test(ua) ? 'Jorcord' : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  if (app && os) return `${app} on ${os}`;
  return app || os || 'an unknown device';
}
