import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { ApiException } from '@/lib/transport';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/primitives';
import { FIXED_SERVER, getServerUrl, isCapacitor, isNative } from '@/lib/server';
import { setRemember } from '@/lib/authStorage';
import { QrLogin } from '@/components/auth/QrLogin';
import { t } from '@/i18n';

export function Shell({ title, sub, children, footer }: { title: string; sub: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="flex h-full overflow-y-auto bg-[#1e1f22] bg-[radial-gradient(ellipse_at_top,rgba(88,101,242,.35),transparent_60%),radial-gradient(ellipse_at_bottom_right,rgba(235,69,158,.18),transparent_55%)] p-0 sm:items-center sm:justify-center sm:p-6" style={{ paddingTop: 'var(--sat)' }}>
      <main className="m-auto w-full max-w-[480px] animate-pop rounded-md bg-[#313338] p-6 shadow-elev sm:p-8" data-theme="dark">
        <div className="mb-5 flex flex-col items-center text-center"><Logo size={48} className="mb-3" /><h1 className="text-2xl font-semibold text-[#f2f3f5]">{title}</h1><p className="mt-1 text-[#b5bac1]">{sub}</p></div>
        {children}
        <div className="mt-3 text-sm text-[#949ba4]">{footer}</div>
        {(isNative() || getServerUrl()) && getServerUrl() && <div data-testid="server-line" className="mt-4 border-t border-[#3f4147] pt-3 text-xs text-[#949ba4]">{t('Server')}: <span className="text-[#dbdee1]">{getServerUrl().replace(/^https?:\/\//, '')}</span>{!FIXED_SERVER && <> · <Link to="/connect" className="text-[#00a8fc] underline">{t('Change server')}</Link></>}</div>}
      </main>
    </div>
  );
}

export const inputCls = 'w-full rounded-[3px] bg-[#1e1f22] px-3 py-2.5 text-[#dbdee1] outline-none ring-0 focus:outline focus:outline-2 focus:outline-[#00a8fc]';
export const labelCls = 'mb-2 block text-xs font-bold uppercase tracking-wide text-[#b5bac1]';

/** `remember`: keep the session after the tab / app is closed (localStorage) instead of for this tab only (sessionStorage). */
export async function finishAuth(r: Awaited<ReturnType<typeof api.auth.login>>, remember = true) {
  setRemember(remember);
  useAuth.getState().set(r.accessToken, r.refreshToken); useData.getState().setMe(r.user);
}

export function LoginPage() {
  const nav = useNavigate(); const [sp] = useSearchParams(); const next = sp.get('next') || '/channels/@me';
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [totp, setTotp] = useState(''); const [mfa, setMfa] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [remember, setRem] = useState(true);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api.auth.login({ email, password, totp: mfa ? totp : undefined }); await finishAuth(r, remember); nav(next, { replace: true }); }
    catch (ex) {
      const x = ex as ApiException;
      if (x.code === 'MFA_REQUIRED' || (x.status === 401 && /mfa|totp|two/i.test(x.code + x.message))) { setMfa(true); setErr(totp ? 'Invalid authentication code.' : ''); }
      else setErr(x.status === 0 ? x.message : x.message || 'Login or password is invalid.');
      setBusy(false);
    }
  };
  return (
    <Shell title={t('Welcome back!')} sub={mfa ? t('Enter the 6-digit code from your authenticator app.') : t("We're so excited to see you again!")} footer={<>{t('Need an account?')} <Link to="/register" className="text-[#00a8fc] underline">{t('Register')}</Link></>}>
      <form onSubmit={submit} noValidate>
        {!mfa ? (<>
          <label className="mb-5 block"><span className={labelCls}>{t('Email')} <span className="text-[#f23f43]">*</span></span><input className={inputCls} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label className="mb-2 block"><span className={labelCls}>{t('Password')} <span className="text-[#f23f43]">*</span></span><input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        </>) : (
          <label className="mb-2 block"><span className={labelCls}>{t('Authentication code')}</span><input className={inputCls} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\s/g, ''))} autoFocus /></label>
        )}
        {!mfa && <label className="mt-3 flex items-center gap-2 text-sm text-[#b5bac1]"><input type="checkbox" className="h-4 w-4 accent-[#5865f2]" checked={remember} onChange={(e) => setRem(e.target.checked)} />{t('Remember me')}</label>}
        {!mfa && <Link to="/forgot-password" className="mb-1 mt-2 inline-block text-sm text-[#00a8fc] underline">{t('Forgot your password?')}</Link>}
        {err && <p role="alert" className="mb-2 text-sm text-[#f23f43]">{err}</p>}
        <button disabled={busy || !email || !password || (mfa && totp.length < 6)} className="mt-4 flex h-11 w-full items-center justify-center rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{busy ? <Spinner className="text-white" /> : mfa ? t('Verify') : t('Log In')}</button>
        {mfa && <button type="button" className="mt-3 text-sm text-[#00a8fc] underline" onClick={() => { setMfa(false); setTotp(''); }}>{t('Back')}</button>}
      </form>
      {!mfa && !isCapacitor() && <QrLogin onLogin={async (r) => { await finishAuth(r, remember); nav(next, { replace: true }); }} />}
    </Shell>
  );
}

export function RegisterPage() {
  const nav = useNavigate(); const [sp] = useSearchParams(); const next = sp.get('next') || '/channels/@me';
  const [f, setF] = useState({ email: '', displayName: '', username: '', password: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [agree, setAgree] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api.auth.register({ email: f.email, username: f.username, password: f.password, displayName: f.displayName || undefined }); await finishAuth(r); nav(next, { replace: true }); }
    catch (ex) { setErr((ex as Error).message); setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Shell title={t('Create an account')} sub={t('Free forever. No Nitro required.')} footer={<Link to="/login" className="text-[#00a8fc] underline">{t('Already have an account?')}</Link>}>
      <form onSubmit={submit}>
        <label className="mb-4 block"><span className={labelCls}>{t('Email')} *</span><input className={inputCls} type="email" autoComplete="email" value={f.email} onChange={set('email')} required autoFocus /></label>
        <label className="mb-4 block"><span className={labelCls}>{t('Display Name')}</span><input className={inputCls} value={f.displayName} onChange={set('displayName')} maxLength={32} /></label>
        <label className="mb-4 block"><span className={labelCls}>{t('Username')} *</span><input className={inputCls} autoComplete="username" value={f.username} onChange={set('username')} required minLength={2} maxLength={32} pattern="[a-zA-Z0-9_.]+" title="Letters, numbers, underscores and dots" /></label>
        <label className="mb-4 block"><span className={labelCls}>{t('Password')} *</span><input className={inputCls} type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={8} /></label>
        <label className="mb-2 flex items-start gap-2 text-sm text-[#b5bac1]"><input type="checkbox" className="mt-1 h-4 w-4 accent-[#5865f2]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />{t('I agree to be kind and follow the community guidelines.')}</label>
        {err && <p role="alert" className="mb-2 text-sm text-[#f23f43]">{err}</p>}
        <button disabled={busy || !agree || f.password.length < 8 || !f.username || !f.email} className="mt-2 flex h-11 w-full items-center justify-center rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{busy ? <Spinner className="text-white" /> : t('Continue')}</button>
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.auth.forgotPassword(email); setDone(true); } catch (ex) { setErr((ex as Error).message); } setBusy(false);
  };
  return (
    <Shell title="Forgot your password?" sub="Enter your email and we will send a reset link." footer={<Link to="/login" className="text-[#00a8fc] underline">Back to login</Link>}>
      {done ? <div>
        <p role="status" className="text-[#dbdee1]">If an account exists for <b>{email}</b>, a reset link is on its way. Check your inbox.</p>
        <p className="mt-3 text-sm text-[#b5bac1]">The link expires in 1 hour. If it does not arrive within a few minutes, check your spam folder.</p>
        <button type="button" onClick={() => { setDone(false); setEmail(''); }} className="mt-4 text-sm text-[#00a8fc] underline">Use a different email</button>
      </div> : (
        <form onSubmit={submit}>
          <label className="mb-4 block"><span className={labelCls}>Email</span><input className={inputCls} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          {err && <p role="alert" className="mb-2 text-sm text-[#f23f43]">{err}</p>}
          <button disabled={busy || !email} className="flex h-11 w-full items-center justify-center rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{busy ? <Spinner /> : 'Send reset link'}</button>
        </form>)}
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [sp] = useSearchParams(); const token = sp.get('token') ?? ''; const nav = useNavigate();
  const [check, setCheck] = useState<'checking' | 'valid' | 'invalid'>(token ? 'checking' : 'invalid');
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  useEffect(() => {
    if (!token) return;
    let dead = false;
    api.auth.validateResetToken(token)
      .then((r) => { if (!dead) setCheck(r.valid ? 'valid' : 'invalid'); })
      .catch(() => { if (!dead) setCheck('invalid'); });
    return () => { dead = true; };
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (pw !== pw2) { setErr('Passwords do not match.'); return; }
    setBusy(true); setErr('');
    try { await api.auth.resetPassword(token, pw); useAuth.getState().clear(); setDone(true); setTimeout(() => nav('/login', { replace: true }), 2000); }
    catch (ex) { setErr((ex as Error).message || 'This reset link is invalid or has expired.'); setBusy(false); }
  };
  return (
    <Shell title="Reset password" sub="Choose a new password. All other sessions will be signed out." footer={<Link to="/login" className="text-[#00a8fc] underline">Back to login</Link>}>
      {check === 'checking' ? <div className="flex justify-center py-6"><Spinner /></div>
        : check === 'invalid' ? <div>
          <p role="alert" className="text-[#f23f43]">{token ? 'This reset link is invalid, expired, or has already been used.' : 'This reset link is missing its token.'}</p>
          <Link to="/forgot-password" className="mt-4 inline-block text-sm text-[#00a8fc] underline">Request a new link</Link>
        </div>
        : done ? <div>
          <p role="status" className="text-[#dbdee1]">Password updated. Redirecting to login…</p>
          <Link to="/login" className="mt-3 inline-block text-sm text-[#00a8fc] underline">Sign in now</Link>
        </div> : (
          <form onSubmit={submit}>
            <label className="mb-4 block"><span className={labelCls}>New password</span><input className={inputCls} type="password" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus /></label>
            <label className="mb-4 block"><span className={labelCls}>Confirm password</span><input className={inputCls} type="password" autoComplete="new-password" minLength={8} value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
            {err && <p role="alert" className="mb-2 text-sm text-[#f23f43]">{err}</p>}
            {err && <p className="mb-2 text-sm"><Link to="/forgot-password" className="text-[#00a8fc] underline">Request a new link</Link></p>}
            <button disabled={busy || pw.length < 8} className="flex h-11 w-full items-center justify-center rounded-[3px] bg-[#5865f2] font-medium text-white hover:bg-[#4752c4] disabled:opacity-60">{busy ? <Spinner /> : 'Change password'}</button>
          </form>)}
    </Shell>
  );
}

export function VerifyEmailPage() {
  const [sp] = useSearchParams(); const token = sp.get('token') ?? '';
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'error'); const [msg, setMsg] = useState('');
  const authed = !!useAuth((s) => s.access);
  useEffect(() => {
    if (!token) return;
    let dead = false;
    api.auth.verifyEmail(token).then(() => { if (!dead) setState('ok'); }).catch((e) => { if (!dead) { setState('error'); setMsg((e as Error).message); } });
    return () => { dead = true; };
  }, [token]);
  return (
    <Shell title={state === 'ok' ? 'Email verified' : state === 'error' ? 'Verification failed' : 'Verifying…'} sub="" footer={<Link to={authed ? '/channels/@me' : '/login'} className="text-[#00a8fc] underline">{authed ? 'Continue to Jorcord' : 'Go to login'}</Link>}>
      {state === 'working' && <div className="flex justify-center"><Spinner /></div>}
      {state === 'ok' && <p role="status" className="text-[#dbdee1]">Thanks! Your email address is verified.</p>}
      {state === 'error' && <p role="alert" className="text-[#f23f43]">{msg || 'This verification link is invalid or has expired.'}</p>}
    </Shell>
  );
}
