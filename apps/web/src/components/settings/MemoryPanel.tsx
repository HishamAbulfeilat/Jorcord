import { useEffect, useState, useSyncExternalStore } from 'react';
import { Row, Toggle } from '@/components/ui/primitives';
import { useUI, toast } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { getCaps, isLowMemory, setLowMemory, subscribeMemoryMode } from '@/lib/memory';
import { clearCaches, fmtMB, memoryStats, runMemoryPass, type MemoryStats } from '@/lib/memoryManager';
import { t } from '@/i18n';

/** Settings > Advanced > Memory & performance. */
export function MemoryPanel() {
  const low = useSyncExternalStore(subscribeMemoryMode, isLowMemory, () => false);
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  const [stats, setStats] = useState<MemoryStats | null>(null); const [busy, setBusy] = useState(false);
  const refresh = () => { void memoryStats().then(setStats); };
  useEffect(() => { refresh(); const i = setInterval(refresh, 3000); return () => clearInterval(i); }, []);
  const caps = getCaps();
  const calm = p.reducedMotion && !p.autoplayGifs;
  const toggleLow = (v: boolean) => { setLowMemory(v); useMessages.getState().evict(); runMemoryPass(); refresh(); };
  const clear = async () => { setBusy(true); try { await clearCaches(); toast(t('Caches cleared.'), 'success'); } finally { setBusy(false); refresh(); } };
  return (
    <section aria-label={t('Memory & performance')} data-testid="memory-panel">
      <h2 className="mb-4 text-xl font-bold text-header">{t('Memory & performance')}</h2>
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-side p-4 text-sm sm:grid-cols-3" data-testid="memory-stats">
        <div><dt className="text-muted">{t('JS heap')}</dt><dd className="font-mono text-header" data-testid="stat-heap">{stats?.heapBytes != null ? fmtMB(stats.heapBytes) : t('Not available in this browser')}</dd></div>
        <div><dt className="text-muted">{t('Stored by the app')}</dt><dd className="font-mono text-header">{fmtMB(stats?.storageBytes ?? null)}</dd></div>
        <div><dt className="text-muted">{t('Channels in memory')}</dt><dd className="font-mono text-header" data-testid="stat-channels">{stats?.channelsCached ?? 0} / {caps.channels}</dd></div>
        <div><dt className="text-muted">{t('Messages in memory')}</dt><dd className="font-mono text-header" data-testid="stat-messages">{stats?.messagesCached ?? 0}</dd></div>
        <div><dt className="text-muted">{t('Users cached')}</dt><dd className="font-mono text-header">{stats?.usersCached ?? 0}</dd></div>
        <div><dt className="text-muted">{t('Cached requests')}</dt><dd className="font-mono text-header">{stats?.queries ?? 0}</dd></div>
      </dl>
      <Row title={t('Low-memory mode')} desc={t('Keeps fewer channels, messages and animated images in memory. Recommended for phones, old computers and very long sessions. Applies to this device only.')}>
        <Toggle label={t('Low-memory mode')} checked={low} onChange={toggleLow} />
      </Row>
      <Row title={t('Reduce animations and stop auto-playing GIFs')} desc={t('Animated images show their first frame until you hover or tap them, and UI motion is turned off.')}>
        <Toggle label={t('Reduce animations and stop auto-playing GIFs')} checked={calm} onChange={(v) => { set('reducedMotion', v); set('autoplayGifs', !v); }} />
      </Row>
      <Row title={t('Clear caches')} desc={t('Frees cached messages from channels you are not looking at, unused user data and the image cache. Nothing is deleted from your account.')}>
        <button className="btn btn-secondary" disabled={busy} onClick={() => void clear()} data-testid="clear-caches">{t('Clear caches')}</button>
      </Row>
    </section>
  );
}
