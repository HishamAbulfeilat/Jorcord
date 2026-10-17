import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthResult, type RemoteAuthCode } from '@/lib/api';
import { ApiException } from '@/lib/transport';
import { qrPayload } from '@/lib/qrLogin';
import { QrCode } from '@/components/ui/QrCode';
import { Spinner } from '@/components/ui/primitives';
import { t } from '@/i18n';

const POLL_MS = 2000;

/**
 * "Log in with QR code": shows a short-lived code and polls until a signed-in phone has scanned and confirmed it.
 * The code is replaced when it expires; `onLogin` receives the new session once the phone approves.
 */
export function QrLogin({ onLogin }: { onLogin: (r: AuthResult) => void | Promise<void> }) {
  const [code, setCode] = useState<RemoteAuthCode | null>(null);
  const [stage, setStage] = useState<'pending' | 'scanned'>('pending');
  const [err, setErr] = useState('');
  const [tries, setTries] = useState(0);
  const loginRef = useRef(onLogin); loginRef.current = onLogin;

  useEffect(() => {
    let dead = false; let timer: ReturnType<typeof setTimeout> | undefined;
    setCode(null); setStage('pending'); setErr('');
    const renew = () => { if (!dead) setTries((n) => n + 1); };
    (async () => {
      let c: RemoteAuthCode;
      try { c = await api.auth.remoteCreate(); } catch (e) { if (!dead) setErr((e as Error).message); return; }
      if (dead) return;
      setCode(c);
      const tick = async () => {
        if (dead) return;
        if (Date.now() >= new Date(c.expiresAt).getTime()) return renew(); // expired: show a fresh code
        try {
          const r = await api.auth.remotePoll(c.id, c.pollSecret);
          if (dead) return;
          if (r.status === 'approved') { dead = true; await loginRef.current(r); return; }
          setStage(r.status);
        } catch (e) {
          if (dead) return;
          const x = e as ApiException;
          if (x.status === 410 || x.status === 404) return renew();
          if (x.status === 403) { setErr(t('Login was declined on your phone.')); return; }
          if (x.status === 429) { timer = setTimeout(tick, POLL_MS * 5); return; }
        }
        timer = setTimeout(tick, POLL_MS);
      };
      timer = setTimeout(tick, POLL_MS);
    })();
    return () => { dead = true; clearTimeout(timer); };
  }, [tries]);

  const retry = useCallback(() => setTries((n) => n + 1), []);
  return (
    <section aria-label={t('Log in with QR code')} className="mt-5 flex flex-col items-center border-t border-[#3f4147] pt-5 text-center">
      <h2 className="text-base font-semibold text-[#f2f3f5]">{t('Log in with QR code')}</h2>
      <div className="mt-3 flex h-[176px] w-[176px] items-center justify-center rounded-md bg-white">
        {code && !err ? <QrCode text={qrPayload(code)} label={t('Login QR code')} /> : err ? null : <Spinner />}
      </div>
      {err ? <>
        <p role="alert" className="mt-3 text-sm text-[#f23f43]">{err}</p>
        <button type="button" onClick={retry} className="mt-2 text-sm text-[#00a8fc] underline">{t('Show a new code')}</button>
      </> : <p role="status" className="mt-3 max-w-[300px] text-sm text-[#b5bac1]">
        {stage === 'scanned' ? t('Check your phone and confirm the login.') : t('Open Jorcord on your phone, go to Settings, tap Scan QR code and point it here.')}
      </p>}
    </section>
  );
}
