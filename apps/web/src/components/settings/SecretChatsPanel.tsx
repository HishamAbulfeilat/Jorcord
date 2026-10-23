/** Privacy & Safety > Secret chats: the devices that can read your end-to-end encrypted 1:1 chats, and what the feature does and does not protect. */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Lock, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { defaultKeyStore } from '@/lib/e2ee/keystore';
import { ensureLocalDevice } from '@/lib/e2ee/service';
import { fingerprint, formatFingerprint } from '@/lib/e2ee/crypto';
import { fromB64u } from '@jorcord/shared';
import { H3 } from './SettingsLayout';
import { t } from '@/i18n';

export function SecretChatsPanel() {
  const meId = useData((s) => s.me?.id);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['e2ee-devices'], queryFn: () => api.e2ee.devices(), retry: false });
  const [here, setHere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof globalThis.crypto?.subtle !== 'undefined';
  useEffect(() => { if (meId) void defaultKeyStore().then((s) => s.getIdentity(meId)).then((i) => setHere(i?.deviceId ?? null)).catch(() => setHere(null)); }, [meId, q.data]);
  if (q.isError) return null; // a server without secret chats
  const refresh = () => qc.invalidateQueries({ queryKey: ['e2ee-devices'] });
  const setup = async () => { if (!meId) return; setBusy(true); try { const d = await ensureLocalDevice(meId); setHere(d.deviceId); toast(t('This device is ready for secret chats'), 'success'); await refresh(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const revoke = async (id: string) => {
    if (!window.confirm(t('Revoke this device? It will no longer be able to read new secret messages, and people you chat with will see a safety number change.'))) return;
    try { await api.e2ee.revoke(id); await refresh(); } catch (e) { toastError(e); }
  };
  return (<section data-testid="secret-chats-panel">
    <H3>{t('Secret chats')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Start a secret chat from someone\'s profile menu. Messages are encrypted on your device and can only be read on the devices listed here. The server stores ciphertext only, so it cannot search, preview links in, or moderate them, and cannot recover them for you.')}</p>
    <ul className="mb-2 rounded-lg bg-side p-1 text-sm text-muted">
      <li className="px-2 py-1">{t('Each device has its own key. A device you add later cannot read messages sent before it was added.')}</li>
      <li className="px-2 py-1">{t('Lose every device (or clear this browser\'s data) and your secret chat history is gone for good.')}</li>
      <li className="px-2 py-1">{t('One-to-one only: there is no end-to-end encryption in group DMs or servers. Attachments are not supported.')}</li>
    </ul>
    {!supported && <p role="alert" className="mb-2 text-sm text-danger">{t('This browser does not offer the cryptography secret chats need (it requires a secure https page).')}</p>}
    {q.data && !q.data.length && <p className="mb-2 text-sm text-muted" data-testid="no-e2ee-devices">{t('No device is set up yet. One is created the first time you start or open a secret chat.')}</p>}
    <ul aria-label={t('Devices that can read your secret chats')}>
      {q.data?.map((d) => (
        <li key={d.id} data-device={d.id} className="flex items-center gap-3 border-b border-divider/50 py-3">
          <Laptop size={22} className="text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-header">{d.label ?? t('Device')}{d.id === here && <span className="ms-2 rounded bg-success px-1 text-[10px] font-bold text-white">{t('THIS DEVICE')}</span>}</div>
            <Fp publicKey={d.publicKey} />
          </div>
          <button aria-label={t('Revoke device')} className="p-2 text-danger" onClick={() => void revoke(d.id)}><Trash2 size={18} /></button>
        </li>
      ))}
    </ul>
    {supported && !here && <button className="btn btn-secondary mt-3" disabled={busy} onClick={() => void setup()}><Lock size={14} className="me-1 inline" aria-hidden />{t('Set up this device')}</button>}
  </section>);
}

function Fp({ publicKey }: { publicKey: string }) {
  const [fp, setFp] = useState('');
  useEffect(() => { void fingerprint(fromB64u(publicKey)).then((h) => setFp(formatFingerprint(h.slice(0, 32)))).catch(() => {}); }, [publicKey]);
  return <div className="truncate font-mono text-xs text-muted" title={fp}>{fp}</div>;
}
