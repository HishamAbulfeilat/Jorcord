import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { USERNAME_CHANGE_LIMIT, USERNAME_RE } from '@jorcord/shared';
import { api3c } from '@/lib/api3c';
import { logout } from '@/lib/auth';
import { useData } from '@/stores/data';
import { toast, toastError, useUI } from '@/stores/ui';
import { H3 } from './SettingsLayout';
import { Field } from '@/components/ui/primitives';
import { t } from '@/i18n';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Password (and the authenticator code with two-factor on): the same confirmation every sensitive account change asks for. */
function Confirm({ password, setPassword, code, setCode }: { password: string; setPassword: (v: string) => void; code: string; setCode: (v: string) => void }) {
  const mfa = useData((s) => !!s.me?.mfaEnabled);
  return (<>
    <Field label={t('Current Password')}><input type="password" autoComplete="current-password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    {mfa && <Field label={t('Authentication code')}><input className="field" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>}
  </>);
}

/** Why a username cannot be submitted yet, or null (mirrors the server rule). */
export const usernameProblem = (name: string, current: string): string | null => {
  const n = name.trim().toLowerCase();
  if (!USERNAME_RE.test(n)) return 'Use 2-32 characters: a-z, 0-9, _ and .';
  if (n === current.toLowerCase()) return 'That is already your username';
  return null;
};

export function UsernameChange() {
  const me = useData((s) => s.me)!; const qc = useQueryClient();
  const status = useQuery({ queryKey: ['username-status'], queryFn: api3c.usernameStatus, retry: false });
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const problem = name ? usernameProblem(name, me.username) : null;
  const left = status.data?.changesLeft ?? USERNAME_CHANGE_LIMIT.changes;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api3c.changeUsername({ username: name.trim(), password: pw, ...(code ? { totp: code } : {}) });
      useData.getState().apply('USER_UPDATE', r.user);
      void qc.invalidateQueries({ queryKey: ['username-status'] });
      toast(t('Username changed'), 'success'); setOpen(false); setName(''); setPw(''); setCode('');
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  return (<>
    <H3>{t('Username')}</H3>
    <p className="mb-2 text-sm text-muted">{t('You can change your username')} {USERNAME_CHANGE_LIMIT.changes} {t('times every')} {USERNAME_CHANGE_LIMIT.windowDays} {t('days. Your old username is held for you for')} {USERNAME_CHANGE_LIMIT.reserveDays} {t('days so nobody else can take it.')}</p>
    {!open ? (
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-secondary" disabled={left <= 0} data-testid="username-change-open" onClick={() => setOpen(true)}>{t('Change username')}</button>
        {left <= 0 && status.data?.nextChangeAt && <span className="text-sm text-muted">{t('Next change available')} {fmtDate(status.data.nextChangeAt)}</span>}
        {left > 0 && status.data && <span className="text-sm text-muted">{left} {t('changes left')}</span>}
      </div>
    ) : (
      <form className="max-w-sm" onSubmit={submit} data-testid="username-change-form">
        <Field label={t('New username')}><input className="field" autoFocus maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder={me.username} />
          {problem && <span role="alert" className="mt-1 block text-xs text-danger">{t(problem)}</span>}</Field>
        <Confirm password={pw} setPassword={setPw} code={code} setCode={setCode} />
        <div className="flex gap-2"><button disabled={busy || !name || !!problem || !pw} className="btn btn-primary">{t('Change username')}</button><button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>{t('Cancel')}</button></div>
      </form>
    )}
  </>);
}

export function EmailChange() {
  const me = useData((s) => s.me)!; const qc = useQueryClient();
  const pending = useQuery({ queryKey: ['email-change'], queryFn: api3c.pendingEmail, retry: false });
  const [open, setOpen] = useState(false); const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api3c.changeEmail({ newEmail: email.trim(), password: pw, ...(code ? { totp: code } : {}) });
      toast(`${t('We sent a confirmation link to')} ${r.pendingEmail}`, 'success');
      void qc.invalidateQueries({ queryKey: ['email-change'] }); setOpen(false); setEmail(''); setPw(''); setCode('');
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  const cancel = () => api3c.cancelEmailChange().then(() => qc.invalidateQueries({ queryKey: ['email-change'] })).catch(toastError);
  const p = pending.data?.pendingEmail;
  return (<>
    <H3>{t('Email')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Your email changes only after you confirm the link we send to the new address. You will be signed out everywhere afterwards, and your current address gets a notice.')}</p>
    {p && (
      <div className="mb-3 rounded-lg bg-side p-3 text-sm" role="status" data-testid="email-pending">
        {t('Waiting for you to confirm')} <b className="text-header">{p}</b>. {t('Check that inbox for the link.')}
        <button className="btn btn-link ms-2" onClick={() => void cancel()}>{t('Cancel change')}</button>
      </div>
    )}
    {!open ? <button className="btn btn-secondary" data-testid="email-change-open" onClick={() => setOpen(true)}>{t('Change email')}</button> : (
      <form className="max-w-sm" onSubmit={submit} data-testid="email-change-form">
        <Field label={t('New email address')}><input type="email" className="field" autoFocus maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={me.email} /></Field>
        <Confirm password={pw} setPassword={setPw} code={code} setCode={setCode} />
        <div className="flex gap-2"><button disabled={busy || !email.includes('@') || !pw} className="btn btn-primary">{t('Send confirmation')}</button><button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>{t('Cancel')}</button></div>
      </form>
    )}
  </>);
}

/** Reversible disable (sign in again to come back) next to the permanent delete in "Download your data". */
export function DisableAccount() {
  const [open, setOpen] = useState(false); const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await api3c.disableAccount({ password: pw, ...(code ? { totp: code } : {}) }); useUI.getState().openSettings(null); toast(t('Your account is disabled. Sign in again to bring it back.'), 'info'); logout(); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (<>
    <H3>{t('Disable account')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Take a break: you are signed out everywhere and appear offline. Nothing is deleted; signing in again turns your account back on. To erase it for good, use Delete Account below.')}</p>
    {!open ? <button className="btn btn-secondary" data-testid="disable-open" onClick={() => setOpen(true)}>{t('Disable account')}</button> : (
      <form className="max-w-sm" onSubmit={(e) => { e.preventDefault(); void run(); }} data-testid="disable-form">
        <Confirm password={pw} setPassword={setPw} code={code} setCode={setCode} />
        <div className="flex gap-2"><button disabled={busy || !pw} className="btn btn-danger">{t('Disable my account')}</button><button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>{t('Cancel')}</button></div>
      </form>
    )}
  </>);
}

/** My Account additions: username, email, and the reversible disable. */
export function AccountChanges() {
  return (<><UsernameChange /><EmailChange /></>);
}
