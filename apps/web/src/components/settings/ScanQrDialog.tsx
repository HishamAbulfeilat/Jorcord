import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, type RemoteAuthScan } from '@/lib/api';
import { describeDevice, isOtherServer, parseQrPayload, type QrLoginPayload } from '@/lib/qrLogin';
import { toast } from '@/stores/ui';
import { Spinner } from '@/components/ui/primitives';
import { ensurePermission, reportPermissionFailure } from '@/lib/permissionFlow';
import { classifyMediaError, failureMessage } from '@/lib/permissions';
import { t } from '@/i18n';

/**
 * Settings -> "Scan QR code": point the camera at the code on the login page of another device, then confirm "Log in on <device>?".
 * Uses the BarcodeDetector API where it exists (Chrome, Android WebView) and jsQR otherwise (Safari / iOS WebView, Firefox).
 */
export function ScanQrDialog({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ payload: QrLoginPayload; scan: RemoteAuthScan } | null>(null);
  const foundRef = useRef(false);

  const handle = async (text: string) => {
    if (foundRef.current) return;
    const payload = parseQrPayload(text);
    if (!payload) { setError(t('That is not a Jorcord login code.')); return; }
    if (isOtherServer(payload)) { setError(t('This code belongs to a different server.')); return; }
    foundRef.current = true; setBusy(true); setError('');
    try { setFound({ payload, scan: await api.auth.remoteScan(payload.id, payload.secret) }); }
    catch (e) { foundRef.current = false; setError((e as Error).message || t('This code has expired. Ask for a new one.')); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    let stop = false; let stream: MediaStream | undefined; let raf = 0;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setError(t('This device has no camera access. Paste the code instead.')); return; }
      if (!(await ensurePermission('camera'))) { if (!stop) setError(t('The camera is off. Allow it, or paste the code instead.')); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
      catch (err) { if (!stop) { setError(failureMessage('camera', classifyMediaError(err)) + ' ' + t('Or paste the code instead.')); void reportPermissionFailure('camera', err); } return; }
      if (stop) { stream.getTracks().forEach((x) => x.stop()); return; }
      const v = video.current; if (!v) return;
      v.srcObject = stream; v.setAttribute('playsinline', 'true'); await v.play().catch(() => {});
      const BD = (window as any).BarcodeDetector;
      const detector = BD ? new BD({ formats: ['qr_code'] }) : null;
      const jsQR = detector ? null : (await import('jsqr')).default;
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const loop = async () => {
        if (stop || foundRef.current) return;
        if (v.readyState >= 2 && v.videoWidth) {
          try {
            let text: string | undefined;
            if (detector) text = (await detector.detect(v))[0]?.rawValue;
            else if (jsQR && ctx) {
              const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
              canvas.width = w; canvas.height = h; ctx.drawImage(v, 0, 0, w, h);
              text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data;
            }
            if (text) await handle(text);
          } catch { /* a frame that cannot be read: try the next one */ }
        }
        raf = requestAnimationFrame(() => { void loop(); });
      };
      void loop();
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((x) => x.stop()); };
  }, []); // eslint-disable-line

  const answer = async (approve: boolean) => {
    if (!found) return; setBusy(true);
    try {
      await api.auth.remoteConfirm(found.payload.id, found.payload.secret, approve);
      toast(approve ? t('Logged in on the other device.') : t('Login declined.'), approve ? 'success' : 'info');
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const who = found ? describeDevice(found.scan.device.userAgent) : '';
  return (
    <div role="dialog" aria-modal="true" aria-label={t('Scan QR code')} className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-[420px] rounded-lg bg-[rgb(var(--modal-alt))] p-4 text-header shadow-elev" style={{ paddingTop: 'max(1rem, var(--sat))' }}>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">{found ? t('Log in on this device?') : t('Scan QR code')}</h2>
          <button className="btn btn-secondary !p-1" aria-label={t('Close')} onClick={onClose}><X size={18} /></button></div>
        {found ? (<>
          <p className="mb-1">{t('Log in on')} <b>{who}</b>?</p>
          {found.scan.device.ip && <p className="mb-3 text-xs text-muted">{t('Requested from IP address')} {found.scan.device.ip}</p>}
          <p className="mb-4 text-sm text-muted">{t('Only continue if you just opened the QR code yourself. Anyone you log in gets full access to your account.')}</p>
          {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
          <div className="flex gap-2"><button className="btn btn-primary flex-1" disabled={busy} onClick={() => answer(true)}>{busy ? <Spinner /> : t('Log in')}</button><button className="btn btn-secondary flex-1" disabled={busy} onClick={() => answer(false)}>{t('Cancel')}</button></div>
        </>) : (<>
          <div className="relative mb-3 aspect-square w-full overflow-hidden rounded-md bg-black"><video ref={video} muted playsInline className="h-full w-full object-cover" />{busy && <div className="absolute inset-0 flex items-center justify-center bg-black/50"><Spinner /></div>}</div>
          <p className="mb-2 text-sm text-muted">{t('Point the camera at the QR code on the Jorcord login page.')}</p>
          {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void handle(pasted); }}>
            <input className="field flex-1" placeholder="jorcord://qr-login?…" aria-label={t('Login code')} value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button className="btn btn-secondary" disabled={!pasted.trim() || busy}>{t('Use code')}</button>
          </form>
        </>)}
      </div>
    </div>
  );
}
