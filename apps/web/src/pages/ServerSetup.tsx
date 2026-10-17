import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Server } from 'lucide-react';
import { Shell, inputCls, labelCls } from './AuthPages';
import { Spinner } from '@/components/ui/primitives';
import { getServerUrl, isNative, isStaticHost, validateServer } from '@/lib/server';
import { switchServer } from '@/lib/serverSwitch';
import { t } from '@/i18n';

/** "Connect to a server": first screen inside the Tauri / Capacitor wrappers, also reachable from login and settings. */
export function ServerSetupPage() {
  const nav = useNavigate(); const [sp] = useSearchParams();
  const [v, setV] = useState(getServerUrl()); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const r = await validateServer(v);
    if (!r.ok) { setErr(r.error); setBusy(false); return; }
    switchServer(r.origin);
    nav(sp.get('next') || '/login', { replace: true });
  };
  return (
    <Shell title={t('Connect to a server')} sub={t('Enter the address of the Jorcord server you want to use.')} footer={<span>{isNative() || isStaticHost() ? t('You can change the server later from the login screen or in Settings.') : t('Leave this page to keep using this site.')}</span>}>
      <form onSubmit={submit} noValidate data-testid="server-setup">
        <label className="mb-2 block"><span className={labelCls}>{t('Server address')} <span className="text-[#f23f43]">*</span></span>
          <div className="relative"><Server size={18} className="pointer-events-none absolute start-3 top-3 text-[#949ba4]" />
            <input className={inputCls + ' ps-10'} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="url" placeholder="chat.example.com" value={v} onChange={(e) => setV(e.target.value)} autoFocus aria-label={t('Server address')} /></div></label>
        {err && <p role="alert" className="mb-2 text-sm text-[#f23f43]">{err}</p>}
        <button disabled={busy || !v.trim()} className="mt-3 flex h-11 w-full items-center justify-center rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{busy ? <Spinner className="text-white" /> : t('Connect')}</button>
      </form>
    </Shell>
  );
}
