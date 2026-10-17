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

/** Plain web: true when the server now deploys a different build than the one running in this tab. */
export async function webBuildChanged(current: string, base: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetcher(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j?.build === 'string' && j.build !== '' && j.build !== current;
  } catch { return false; }
}
