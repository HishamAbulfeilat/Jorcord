import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { desktop } from '@/lib/native';
import { isCapacitor, isNative, isTauri, nativePlatform } from '@/lib/server';
import { CHECK_INTERVAL_MS, applyWebUpdate, dismissUpdate, dismissedUpdate, newerRelease, reloadAlreadyTried, serverBuild, webUpdateId, type ReleaseInfo } from '@/lib/updates';
import { t } from '@/i18n';

type Notice =
  | { kind: 'desktop'; version: string; install: () => Promise<void> }
  | { kind: 'mobile'; version: string; href: string }
  | { kind: 'web'; build: string };

/** One banner for all platforms: desktop (Tauri updater), Android / iOS (newer GitHub release) and web (the server deploys a new build). */
export function UpdateBanner() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    // Every check decides the banner from scratch: a dismissed version stays hidden, and a notice that no longer applies (rollback, already updated) goes away.
    const show = (n: Notice | null, id?: string) => { if (!dead) setNotice(n && id !== undefined && dismissedUpdate() === id ? null : n); };
    const check = async () => {
      try {
        if (isTauri()) {
          const u = await desktop.checkUpdate();
          show(u ? { kind: 'desktop', version: u.version, install: u.install } : null, u?.version);
        } else if (isCapacitor()) {
          const r: ReleaseInfo | null = await newerRelease(__APP_VERSION__);
          show(r ? { kind: 'mobile', version: r.version, href: nativePlatform() === 'android' && r.apk ? r.apk : r.page } : null, r?.version);
        } else if (!isNative()) {
          const b = await serverBuild(import.meta.env.BASE_URL);
          // same build, unreadable answer, or we already reloaded for this build and it did not take (inconsistent deploy): nothing to offer
          const changed = b !== null && b !== __BUILD_ID__ && !reloadAlreadyTried(b);
          if (b !== null) show(changed ? { kind: 'web', build: b } : null, b ? webUpdateId(b) : undefined);
        }
      } catch { /* update checks are best effort */ }
    };
    void check();
    const timer = setInterval(check, isNative() ? CHECK_INTERVAL_MS : 30 * 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible' && !isNative()) void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { dead = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!notice) return null;
  const dismiss = () => { dismissUpdate(notice.kind === 'web' ? webUpdateId(notice.build) : notice.version); setNotice(null); };
  const btn = 'rounded bg-white/20 px-2 py-0.5 font-semibold hover:bg-white/30 disabled:opacity-60';
  return (
    <div role="status" data-testid="update-banner" className="flex items-center justify-center gap-3 bg-brand px-3 py-1 text-xs text-white safe-top">
      <Download size={14} className="shrink-0" />
      {notice.kind === 'desktop' && <>
        <span>{err || (busy ? t('Downloading the update…') : `Jorcord ${notice.version} ${t('is available, restart to update')}`)}</span>
        <button className={btn} disabled={busy} onClick={() => { setBusy(true); setErr(''); notice.install().then(() => { setTimeout(() => setBusy(false), 15_000); }).catch((e) => { setErr((e as Error).message || t('The update failed.')); setBusy(false); }); }}>{t('Restart to update')}</button>
      </>}
      {notice.kind === 'mobile' && <>
        <span>{t('Update available')}: Jorcord {notice.version}</span>
        <a className={btn} href={notice.href} target="_blank" rel="noreferrer">{t('Update')}</a>
      </>}
      {notice.kind === 'web' && <>
        <span>{t('A new version is available, reload')}</span>
        <button className={btn} disabled={busy} onClick={() => { setBusy(true); void applyWebUpdate(notice.build); }}>{t('Reload')}</button>
      </>}
      {notice.kind !== 'desktop' || !busy ? <button aria-label={t('Dismiss')} className="ms-1 rounded p-0.5 hover:bg-white/20" onClick={dismiss}><X size={14} /></button> : null}
    </div>
  );
}
