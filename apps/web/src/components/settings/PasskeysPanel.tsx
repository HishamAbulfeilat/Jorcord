import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
import { api, type Passkey } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/toast';
import { t } from '@/i18n';

/** Settings > Security: list, add, rename and remove passkeys. Adding or removing needs the password (and the 2FA code when 2FA is on). */
export function PasskeysPanel() {
  const mfa = useData((s) => !!s.me?.mfaEnabled);
  const list = useQuery({ queryKey: ['passkeys'], queryFn: api.auth.passkeys, retry: false });
  const [ask, setAsk] = useState<null | { kind: 'add' } | { kind: 'remove'; pk: Passkey }>(null);
  const [password, setPassword] = useState(''); const [totp, setTotp] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const supported = browserSupportsWebAuthn();
  const close = () => { setAsk(null); setPassword(''); setTotp(''); setName(''); };
  const creds = () => ({ password, ...(mfa && totp ? { totp } : {}) });

  const confirm = async () => {
    if (!ask) return; setBusy(true);
    try {
      if (ask.kind === 'add') {
        const options = await api.auth.passkeyRegisterOptions(creds());
        const response = await startRegistration({ optionsJSON: options });
        await api.auth.passkeyRegisterVerify(response, name.trim() || undefined);
        toast(t('Passkey added'), 'success');
      } else {
        await api.auth.passkeyDelete(ask.pk.id, creds());
        toast(t('Passkey removed'), 'success');
      }
      close(); void list.refetch();
    } catch (e: any) {
      if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') toast(t('Passkey request was cancelled'), 'error'); else toastError(e);
    } finally { setBusy(false); }
  };

  return (<>
    <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-wide text-muted">{t('Passkeys')}</h3>
    <p className="mb-2 text-sm text-muted">{t('Sign in with your fingerprint, face or device PIN instead of a password. Passkeys are phishing-resistant and never leave your device.')}</p>
    <ul data-testid="passkey-list">{list.data?.map((p) => (
      <li key={p.id} className="flex items-center gap-3 border-b border-divider/50 py-3"><KeyRound size={22} className="text-muted" />
        <div className="min-w-0 flex-1">
          {renaming?.id === p.id
            ? <form onSubmit={(e) => { e.preventDefault(); api.auth.passkeyRename(p.id, renaming.name).then(() => { setRenaming(null); void list.refetch(); }).catch(toastError); }}><input className="field !w-56" aria-label={t('Passkey name')} value={renaming.name} maxLength={64} autoFocus onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} onBlur={() => setRenaming(null)} /></form>
            : <div className="truncate text-header">{p.name}{p.backedUp && <span className="ms-2 text-xs text-muted">{t('synced')}</span>}</div>}
          <div className="text-xs text-muted">{t('Added')} {new Date(p.createdAt).toLocaleDateString()} • {p.lastUsedAt ? `${t('Last used')} ${new Date(p.lastUsedAt).toLocaleDateString()}` : t('Never used')}</div>
        </div>
        <button className="btn btn-secondary" aria-label={`${t('Rename')} ${p.name}`} onClick={() => setRenaming({ id: p.id, name: p.name })}><Pencil size={14} /></button>
        <button className="btn btn-danger" aria-label={`${t('Remove')} ${p.name}`} onClick={() => setAsk({ kind: 'remove', pk: p })}><Trash2 size={14} /></button>
      </li>))}</ul>
    {!list.isLoading && !list.data?.length && <p className="mb-2 text-sm text-muted">{t('No passkeys yet.')}</p>}
    {!ask && <button className="btn btn-primary mt-2" disabled={!supported} title={supported ? undefined : t('This browser does not support passkeys')} onClick={() => setAsk({ kind: 'add' })}>{t('Add a passkey')}</button>}
    {ask && (
      <form className="mt-2 rounded-lg bg-side p-4" onSubmit={(e) => { e.preventDefault(); void confirm(); }} data-testid="passkey-confirm">
        <p className="mb-2 text-sm">{ask.kind === 'add' ? t('Confirm your password to add a passkey.') : `${t('Confirm your password to remove')} “${ask.pk.name}”.`}</p>
        <div className="flex flex-wrap gap-2">
          {ask.kind === 'add' && <input className="field !w-48" placeholder={t('Name (optional)')} aria-label={t('Passkey name')} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />}
          <input className="field !w-48" type="password" autoComplete="current-password" placeholder={t('Password')} aria-label={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {mfa && <input className="field !w-32" inputMode="numeric" placeholder={t('2FA code')} aria-label={t('Authentication code')} maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />}
          <button className={ask.kind === 'add' ? 'btn btn-primary' : 'btn btn-danger'} disabled={busy || !password || (mfa && totp.length < 6)}>{ask.kind === 'add' ? t('Continue') : t('Remove')}</button>
          <button type="button" className="btn btn-secondary" onClick={close}>{t('Cancel')}</button>
        </div>
      </form>)}
  </>);
}
