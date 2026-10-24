/**
 * In-app update notices. Desktop uses the Tauri updater (see desktop.checkUpdate in native.ts). Mobile has no store listing, so it compares its own
 * version with the newest GitHub release. The plain web app compares its build id with the one the server currently deploys (/version.json).
 */
export const RELEASES_API = 'https://api.github.com/repos/HishamAbulfeilat/Jorcord/releases/latest';
export const CHECK_INTERVAL_MS = 6 * 3600_000;
const CACHE_KEY = 'jorcord.update.release.v1';

export interface ReleaseInfo { version: string; page: string; apk: string | null }

const parts = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
/** >0 when a is newer than b ("1.10.0" > "1.9.2"). Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a).slice(0, 3), y = parts(b).slice(0, 3);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

/** Reduce the GitHub API answer to what the banner needs (the universal APK is the one that installs everywhere). */
export function toReleaseInfo(j: any): ReleaseInfo | null {
  if (!j || typeof j.tag_name !== 'string' || j.draft || j.prerelease) return null;
  const assets: { name?: string; browser_download_url?: string }[] = Array.isArray(j.assets) ? j.assets : [];
  const apk = assets.find((a) => /android-universal\.apk$/i.test(a.name ?? '')) ?? assets.find((a) => /\.apk$/i.test(a.name ?? ''));
  const page = typeof j.html_url === 'string' && /^https:\/\/github\.com\//.test(j.html_url) ? j.html_url : 'https://github.com/HishamAbulfeilat/Jorcord/releases/latest';
  const dl = apk?.browser_download_url;
  return { version: j.tag_name.replace(/^v/i, ''), page, apk: typeof dl === 'string' && /^https:\/\/github\.com\//.test(dl) ? dl : null };
}

/** Latest GitHub release, hitting the API at most once per `CHECK_INTERVAL_MS` (failures are cached too, so a flaky network does not retry on every launch). */
export async function latestRelease(now = Date.now(), fetcher: typeof fetch = fetch): Promise<ReleaseInfo | null> {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (c && typeof c.at === 'number' && now - c.at < CHECK_INTERVAL_MS && now >= c.at) return c.release ?? null;
  } catch { /* */ }
  let release: ReleaseInfo | null = null;
  try {
    const r = await fetcher(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
    if (r.ok) release = toReleaseInfo(await r.json());
  } catch { /* offline: try again after the interval */ }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, release })); } catch { /* */ }
  return release;
}

/** A newer release than `current`, or null. */
export async function newerRelease(current: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<ReleaseInfo | null> {
  const r = await latestRelease(now, fetcher);
  return r && compareVersions(r.version, current) > 0 ? r : null;
}

/** Plain web: the build id the server deploys right now, or null when it cannot be read (offline, no version.json, dev server). */
export async function serverBuild(base: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetcher(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const ct = r.headers?.get?.('content-type');
    if (ct && !/json/i.test(ct)) return null; // an SPA fallback page, not our file
    const j = await r.json();
    return typeof j?.build === 'string' && j.build !== '' ? j.build : null;
  } catch { return null; }
}

/** Plain web: true when the server now deploys a different build than the one running in this tab. */
export async function webBuildChanged(current: string, base: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const b = await serverBuild(base, fetcher);
  return b !== null && b !== current;
}

const DISMISSED = 'jorcord.update.dismissed';
const RELOADED = 'jorcord.update.reloaded';
/** Dismissal is remembered per version (desktop / mobile) or per server build (web): a newer one shows again, the same one never does. */
export const dismissedUpdate = (): string | null => { try { return localStorage.getItem(DISMISSED); } catch { return null; } };
export const dismissUpdate = (id: string) => { try { localStorage.setItem(DISMISSED, id); } catch { /* */ } };
export const webUpdateId = (build: string) => `web:${build}`;

/** Registered by main.tsx: asks the service worker to activate the waiting build (workbox-window `updateServiceWorker`). */
let swUpdater: ((reload?: boolean) => Promise<void>) | null = null;
export const setSwUpdater = (f: ((reload?: boolean) => Promise<void>) | null) => { swUpdater = f; };

/** True when we already reloaded for `build` and the tab still runs another one: the deploy is inconsistent, so stay quiet instead of looping or nagging. */
export function reloadAlreadyTried(build: string): boolean {
  try { return sessionStorage.getItem(RELOADED) === build; } catch { return false; }
}

/**
 * Apply a new web build. The old service worker keeps serving the old shell on a plain reload, so activate the new one first; if that is not possible
 * (no worker, update fails) drop the worker + caches and reload from the network. Marks the build so a failed attempt never loops.
 */
export async function applyWebUpdate(build: string, reload: () => void = () => location.reload()): Promise<void> {
  try { sessionStorage.setItem(RELOADED, build); } catch { /* */ }
  try {
    if (swUpdater) { await Promise.race([swUpdater(true), new Promise((r) => setTimeout(r, 4000))]); }
  } catch { /* fall through to the hard path */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
    if (typeof caches !== 'undefined') await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* */ }
  reload();
}
