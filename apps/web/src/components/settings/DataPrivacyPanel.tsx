import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { toast, toastError, useUI } from '@/stores/ui';
import { H3 } from './SettingsLayout';
import { Spinner } from '@/components/ui/primitives';
import { t } from '@/i18n';

const mb = (n: number | null) => (n == null ? '' : n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** My Account: request/download the zip export (one per day) and delete the account. */
export function DataPrivacyPanel() {
  const jobs = useQuery({ queryKey: ['exports'], queryFn: api.dataExport.list, retry: false,
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 2000 : false) });
  const [busy, setBusy] = useState(false);
  const latest = jobs.data?.[0];
  const active = latest?.status === 'queued' || latest?.status === 'running';
  const start = async () => { setBusy(true); try { await api.dataExport.start(); toast(t('Preparing your export. We will email you when it is ready.'), 'success'); await jobs.refetch(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  return (<>
    <H3>{t('Download your data')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Get a zip with your profile, settings, relationships, messages, upload details, server memberships and security summary. Passwords, tokens and keys are never included. One export per day; the file is available for 7 days.')}</p>
    {jobs.isLoading && <Spinner />}
    {latest && (
      <div className="mb-2 rounded-lg bg-side p-3 text-sm" data-testid="export-status">
        {active && <span className="inline-flex items-center gap-2"><Spinner />{t('Preparing your export…')}</span>}
        {latest.status === 'ready' && <span>{t('Your export is ready')} ({mb(latest.sizeBytes)}). {latest.downloadUrl && <a className="text-link underline" href={latest.downloadUrl} download>{t('Download')}</a>} <span className="text-muted">• {t('expires')} {latest.expiresAt && new Date(latest.expiresAt).toLocaleDateString()}</span></span>}
        {latest.status === 'failed' && <span className="text-danger">{latest.error ?? t('The export failed.')}</span>}
        {latest.status === 'expired' && <span className="text-muted">{t('The last export expired.')}</span>}
      </div>)}
    <button className="btn btn-secondary" disabled={busy || active} onClick={() => void start()}>{t('Request data export')}</button>
    <DeleteAccount />
  </>);
}

function DeleteAccount() {
  const mfa = useData((s) => !!s.me?.mfaEnabled);
  const [open, setOpen] = useState(false); const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await api.dataExport.deleteAccount({ password: pw, ...(mfa ? { totp: code } : {}) }); useAuth.getState().clear(); location.assign(import.meta.env.BASE_URL + 'login'); }
    catch (e) { toastError(e); setBusy(false); }
  };
  return (<>
    <H3>{t('Delete account')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Permanently deletes your account, personal data and sign-ins. Your past messages stay in servers, shown as "Deleted User". You must transfer or delete servers you own first. This cannot be undone.')}</p>
    {!open ? <button className="btn btn-danger" onClick={() => setOpen(true)}>{t('Delete account')}</button> : (
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }} data-testid="delete-account-form">
        <input className="field !w-52" type="password" autoComplete="current-password" placeholder={t('Password')} aria-label={t('Password to delete account')} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {mfa && <input className="field !w-32" inputMode="numeric" maxLength={6} placeholder={t('2FA code')} aria-label={t('Authentication code')} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
        <button className="btn btn-danger" disabled={busy || !pw || (mfa && code.length < 6)}>{t('Delete my account')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setPw(''); setCode(''); }}>{t('Cancel')}</button>
      </form>)}
  </>);
}
