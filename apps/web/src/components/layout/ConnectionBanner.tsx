import { useEffect, useState } from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import { getGateway, type GatewayStatus } from '@/lib/gateway';
import { useAuth } from '@/stores/auth';
import { t } from '@/i18n';

/** Drops shorter than this never show a banner (a quick resume should not flash one). */
export const BANNER_DELAY_MS = 1500;
/** After this long without a connection the text admits it is not a blip. */
export const BANNER_SLOW_MS = 30_000;

export type BannerKind = 'connecting' | 'reconnecting' | 'offline' | 'authfailed';

/** Which banner (if any) the raw state calls for. `connected`, `idle` and `closed` (logged out) never show one. */
export function bannerKind(status: GatewayStatus, online: boolean): BannerKind | null {
  if (status === 'authfailed') return 'authfailed';
  if (status === 'idle' || status === 'closed') return null;
  if (!online) return 'offline';
  if (status === 'connected') return null;
  return status === 'connecting' ? 'connecting' : 'reconnecting';
}

/** Gateway status + navigator.onLine, debounced: appears after BANNER_DELAY_MS of continuous trouble, disappears at once. `slow` flips after BANNER_SLOW_MS. */
export function useConnectionBanner(): { kind: BannerKind | null; slow: boolean } {
  const [status, setStatus] = useState<GatewayStatus>(() => getGateway().status);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const gw = getGateway();
    setStatus(gw.status);
    const off = gw.onStatus(setStatus);
    const on = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', down);
    setOnline(navigator.onLine !== false);
    return () => { off(); window.removeEventListener('online', on); window.removeEventListener('offline', down); };
  }, []);
  const want = bannerKind(status, online);
  const [shown, setShown] = useState<BannerKind | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!want) { setShown(null); setSlow(false); return; }
    const a = setTimeout(() => setShown(want), BANNER_DELAY_MS);
    const b = setTimeout(() => setSlow(true), BANNER_SLOW_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [want]);
  // `shown` may lag one render behind a vanished `want`: never render a banner the state no longer asks for
  return { kind: want ? shown : null, slow };
}

export function ConnectionBanner() {
  const { kind, slow } = useConnectionBanner();
  if (!kind) return null;
  const btn = 'rounded bg-black/20 px-2 py-0.5 text-xs font-semibold hover:bg-black/30';
  const retry = () => { getGateway().retryNow?.(); };
  if (kind === 'authfailed') {
    return (
      <div role="alert" data-testid="connection-banner" data-kind={kind} className="flex items-center justify-center gap-3 bg-danger px-3 py-1 text-xs font-semibold text-white safe-top">
        <WifiOff size={14} />{t('Session expired')}
        <button className="rounded bg-white/20 px-2 py-0.5 text-xs font-semibold hover:bg-white/30" onClick={() => useAuth.getState().clear()}>{t('Sign in')}</button>
      </div>
    );
  }
  const text = kind === 'offline' ? t('You are offline') : kind === 'connecting' ? t('Connecting…') : slow ? t('Still trying to reach the server…') : t('Reconnecting…');
  return (
    <div role="status" data-testid="connection-banner" data-kind={kind} className="flex items-center justify-center gap-3 bg-warn px-3 py-1 text-xs font-semibold text-black safe-top">
      <span className="flex items-center gap-2">{kind === 'offline' ? <WifiOff size={14} /> : <Loader2 size={14} className="animate-spin" />}{text}</span>
      <button className={btn} onClick={retry}>{t('Retry now')}</button>
    </div>
  );
}
