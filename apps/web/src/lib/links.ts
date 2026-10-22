/**
 * Link and file safety shown before a click does anything:
 *  - external links (any http(s) host other than this app / server and the domains the user trusts) ask first;
 *  - files with an executable or script type get a warning before they are opened or downloaded.
 * The trusted-domain list is a preference (`trustedLinkDomains`), so it follows the account to other devices.
 */
import { useUI } from '@/stores/ui';
import { getServerUrl } from './server';

/** Lower-case hostname without a leading `www.`, or null when this is not an absolute http(s) URL. */
export function linkHost(url: string): string | null {
  try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; return u.hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function ownHosts(): string[] {
  const out: string[] = [];
  try { out.push(location.hostname.toLowerCase().replace(/^www\./, '')); } catch { /* */ }
  const s = getServerUrl(); const h = s ? linkHost(s) : null; if (h) out.push(h);
  return out;
}

/** A domain is trusted when the user listed it or any parent domain of it (listing `example.com` also covers `docs.example.com`). */
export function isTrustedHost(host: string, trusted: readonly string[]): boolean {
  return trusted.some((d) => host === d || host.endsWith('.' + d));
}

/** True when opening this URL should ask the user first. */
export function needsLinkConfirm(url: string, trusted: readonly string[] = useUI.getState().prefs.trustedLinkDomains ?? [], own: readonly string[] = ownHosts()): boolean {
  const h = linkHost(url);
  if (!h) return false; // not http(s): relative links and anchors are never external
  return !isTrustedHost(h, own) && !isTrustedHost(h, trusted);
}

/** Add a domain to the user's trusted list. Normalises input like `https://www.Example.com/path`; null when it is not a domain. */
export function trustDomain(input: string): string | null {
  const host = linkHost(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  if (!host || !host.includes('.')) return null;
  const { prefs, setPref } = useUI.getState();
  const cur = prefs.trustedLinkDomains ?? [];
  if (!cur.includes(host)) setPref('trustedLinkDomains', [...cur, host].slice(-200));
  return host;
}
export function untrustDomain(host: string) {
  const { prefs, setPref } = useUI.getState();
  setPref('trustedLinkDomains', (prefs.trustedLinkDomains ?? []).filter((d) => d !== host));
}

/** onClick for an `<a>`: when the link needs confirmation, stop the navigation and open the dialog instead. */
export function guardLink(e: { preventDefault(): void; stopPropagation?(): void }, url: string) {
  e.stopPropagation?.();
  if (!needsLinkConfirm(url)) return;
  e.preventDefault();
  useUI.getState().openModal({ kind: 'externalLink', url });
}

/** Extensions that run code, install software or carry active content. Compared against the last extension only, so `report.pdf.exe` is caught. */
const RISKY_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'lnk', 'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'reg', 'dll', 'sys', 'msc', 'gadget',
  'apk', 'aab', 'ipa', 'dmg', 'pkg', 'app', 'command', 'sh', 'bash', 'run', 'bin', 'appimage', 'deb', 'rpm', 'iso', 'img', 'vhd',
  'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'ppam', 'svg', 'html', 'htm', 'xhtml', 'swf', 'scpt',
]);
export function fileExt(name: string): string { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
export function isRiskyFile(name: string): boolean { return RISKY_EXT.has(fileExt(name)); }
/** `invoice.pdf.exe`: a document-looking name hiding an executable type. */
export function hasDeceptiveExtension(name: string): boolean {
  const parts = name.toLowerCase().split('.'); if (parts.length < 3) return false;
  return RISKY_EXT.has(parts[parts.length - 1]!) && ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'gif', 'txt', 'mp3', 'mp4', 'zip'].includes(parts[parts.length - 2]!);
}

/** onClick for a file link / download button: warn first when the type is risky. */
export function guardFile(e: { preventDefault(): void }, url: string, filename: string, download: boolean) {
  if (!isRiskyFile(filename)) return;
  e.preventDefault();
  useUI.getState().openModal({ kind: 'riskyFile', url, filename, download });
}
