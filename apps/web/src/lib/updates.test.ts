import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyWebUpdate, reloadAlreadyTried, serverBuild, setSwUpdater, CHECK_INTERVAL_MS, compareVersions, latestRelease, newerRelease, toReleaseInfo, webBuildChanged } from './updates';

afterEach(() => { localStorage.clear(); });

describe('web update apply flow', () => {
  it('serverBuild ignores non-JSON fallbacks and failures', async () => {
    const html = vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }), json: async () => { throw new Error('no'); } }) as unknown as Response);
    expect(await serverBuild('/', html)).toBeNull();
    const ok = vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ build: 'abc' }) }) as unknown as Response);
    expect(await serverBuild('/', ok)).toBe('abc');
  });
  it('applyWebUpdate activates the worker, remembers the attempt (no reload loop) and reloads', async () => {
    const sw = vi.fn(async () => {}); const reload = vi.fn();
    setSwUpdater(sw); await applyWebUpdate('b2', reload);
    expect(sw).toHaveBeenCalledWith(true); expect(reload).toHaveBeenCalledTimes(1); expect(reloadAlreadyTried('b2')).toBe(true); expect(reloadAlreadyTried('b3')).toBe(false);
    setSwUpdater(null); sessionStorage.clear();
  });
});

const release = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/HishamAbulfeilat/Jorcord/releases/tag/${tag}`, assets: [
  { name: `Jorcord-${tag.slice(1)}-android-arm64-v8a.apk`, browser_download_url: 'https://github.com/x/arm64.apk' },
  { name: `Jorcord-${tag.slice(1)}-android-universal.apk`, browser_download_url: 'https://github.com/x/universal.apk' }] });
const okFetch = (j: unknown) => vi.fn(async () => ({ ok: true, json: async () => j }) as unknown as Response);

describe('version comparison', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2.1')).toBeLessThan(0);
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('GitHub release check', () => {
  it('picks the universal APK and ignores drafts / prereleases / foreign links', () => {
    expect(toReleaseInfo(release('v1.3.0'))).toEqual({ version: '1.3.0', page: 'https://github.com/HishamAbulfeilat/Jorcord/releases/tag/v1.3.0', apk: 'https://github.com/x/universal.apk' });
    expect(toReleaseInfo({ ...release('v1.3.0'), prerelease: true })).toBeNull();
    expect(toReleaseInfo({ ...release('v1.3.0'), draft: true })).toBeNull();
    expect(toReleaseInfo({ ...release('v1.3.0'), html_url: 'https://evil.example/x', assets: [{ name: 'a.apk', browser_download_url: 'https://evil.example/a.apk' }] })?.apk).toBeNull();
  });

  it('calls the API at most once per 6 hours, failures included', async () => {
    const f = okFetch(release('v1.3.0'));
    const t0 = 1_000_000;
    expect((await latestRelease(t0, f as any))?.version).toBe('1.3.0');
    await latestRelease(t0 + CHECK_INTERVAL_MS - 1, f as any);
    expect(f).toHaveBeenCalledTimes(1);
    await latestRelease(t0 + CHECK_INTERVAL_MS, f as any);
    expect(f).toHaveBeenCalledTimes(2);
    localStorage.clear();
    const bad = vi.fn(async () => { throw new Error('offline'); });
    expect(await latestRelease(t0, bad as any)).toBeNull();
    await latestRelease(t0 + 60_000, bad as any);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('only reports a release newer than the running version', async () => {
    expect((await newerRelease('1.2.0', 1, okFetch(release('v1.3.0')) as any))?.version).toBe('1.3.0');
    localStorage.clear();
    expect(await newerRelease('1.3.0', 1, okFetch(release('v1.3.0')) as any)).toBeNull();
    localStorage.clear();
    expect(await newerRelease('1.4.0', 1, okFetch(release('v1.3.0')) as any)).toBeNull();
  });
});

describe('web build check', () => {
  it('flags a different deployed build only', async () => {
    expect(await webBuildChanged('abc', '/', okFetch({ version: '1.2.0', build: 'abc' }) as any)).toBe(false);
    expect(await webBuildChanged('abc', '/', okFetch({ version: '1.2.0', build: 'def' }) as any)).toBe(true);
    expect(await webBuildChanged('abc', '/', okFetch({}) as any)).toBe(false);
    expect(await webBuildChanged('abc', '/', vi.fn(async () => ({ ok: false }) as Response) as any)).toBe(false);
    expect(await webBuildChanged('abc', '/', vi.fn(async () => { throw new Error('x'); }) as any)).toBe(false);
  });
});
