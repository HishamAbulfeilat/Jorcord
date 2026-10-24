import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { api } from '@/lib/api';
import { startSession, endSession } from '@/lib/session';
import { activeAccountId, forgetAccount, rememberAccount } from '@/lib/accounts';
import { AppShell } from '@/components/layout/AppShell';
import { lazyNamed, Lazy } from '@/lib/lazy';
// route-level code splitting: only the shell + the page being opened are downloaded
const auth = () => import('@/pages/AuthPages');
const LoginPage = lazyNamed(auth, 'LoginPage'), RegisterPage = lazyNamed(auth, 'RegisterPage'), ForgotPasswordPage = lazyNamed(auth, 'ForgotPasswordPage'), ResetPasswordPage = lazyNamed(auth, 'ResetPasswordPage'), VerifyEmailPage = lazyNamed(auth, 'VerifyEmailPage'), VerifyEmailChangePage = lazyNamed(auth, 'VerifyEmailChangePage');
const InvitePage = lazyNamed(() => import('@/pages/InvitePage'), 'InvitePage');
const TemplatePage = lazyNamed(() => import('@/pages/TemplatePage'), 'TemplatePage');
const DemoPage = lazyNamed(() => import('@/pages/DemoPage'), 'DemoPage');
const DeveloperPortal = lazyNamed(() => import('@/pages/DeveloperPortal'), 'DeveloperPortal');
const AdminDashboard = lazyNamed(() => import('@/pages/AdminDashboard'), 'AdminDashboard');
const OAuthAuthorize = lazyNamed(() => import('@/pages/OAuthAuthorize'), 'OAuthAuthorize');
const ServerSetupPage = lazyNamed(() => import('@/pages/ServerSetup'), 'ServerSetupPage');
const UserSettings = lazyNamed(() => import('@/components/settings/UserSettings'), 'UserSettings');
const GuildSettings = lazyNamed(() => import('@/components/settings/GuildSettings'), 'GuildSettings');
import { ModalHost } from '@/components/modals/ModalHost';
import { PopoutHost } from '@/components/modals/PopoutHost';
import { ContextMenuHost } from '@/components/ui/ContextMenu';
import { Toasts } from '@/components/ui/Toasts';
import { PermissionHost } from '@/components/ui/PermissionHost';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/primitives';
import { ApiException } from '@/lib/transport';
import { AppEffects } from '@/components/layout/AppEffects';
import { FIXED_SERVER, getServerUrl, isNative, isStaticHost, needsServerSetup, onServerChange } from '@/lib/server';
import { initNative, syncStatusBar } from '@/lib/native';
import { setLocale, t } from '@/i18n';
import { applyA11y } from '@/lib/a11y';
import { PRESENCE_COLOR } from '@/components/ui/Avatar';
import { IncomingCalls } from '@/voice/IncomingCall';

function useThemeEffects() {
  const prefs = useUI((s) => s.prefs); const me = useData((s) => s.me);
  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = prefs.theme; r.dataset.density = prefs.density; r.dataset.reduceMotion = String(prefs.reducedMotion);
    r.style.setProperty('--font-scale', String(prefs.fontScale));
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', prefs.theme === 'light' ? '#e3e5e8' : prefs.theme === 'amoled' ? '#000000' : '#1e1f22');
    if (prefs.highContrast) r.dataset.contrast = 'more'; else delete r.dataset.contrast;
    applyA11y(r, { dyslexiaFont: prefs.dyslexiaFont, colorBlindMode: prefs.colorBlindMode, saturation: prefs.saturation, roleContrast: prefs.roleContrast, theme: prefs.theme }, PRESENCE_COLOR);
    syncStatusBar(prefs.theme);
  }, [prefs]);
  useEffect(() => { if (me?.theme && me.theme !== useUI.getState().prefs.theme && !localStorage.getItem('jorcord.prefs.v1')) useUI.getState().setPref('theme', me.theme); }, [me?.theme]);
}

function Overlays() {
  const settings = useUI((s) => s.settings);
  return (<>
    <Lazy>{settings?.kind === 'user' && <UserSettings initialTab={settings.tab} />}
    {settings?.kind === 'guild' && <GuildSettings guildId={settings.guildId} initialTab={settings.tab} />}</Lazy>
    <ModalHost /><PopoutHost /><ContextMenuHost /><IncomingCalls /><Toasts /><PermissionHost />
  </>);
}

function Splash({ error, retry }: { error?: string; retry?: () => void }) {
  return <div className="flex h-full flex-col items-center justify-center gap-4 bg-rail text-muted"><Logo size={64} className="animate-pulse" />{error ? <><p role="alert">{error}</p><button className="btn btn-primary" onClick={retry}>{t('Retry')}</button></> : <Spinner />}</div>;
}

function Protected() {
  const access = useAuth((s) => s.access); const ready = useData((s) => s.ready); const loc = useLocation();
  const [err, setErr] = useState(''); const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!access) return;
    let dead = false;
    api.users.me().then((u) => { if (dead) return; useData.getState().setMe(u); rememberAccount(u, { access: useAuth.getState().access, refresh: useAuth.getState().refresh }); startSession(useAuth.getState().access!); })
      .catch((e: ApiException) => { if (dead) return; if (e.status === 401) { const id = activeAccountId(); if (id) forgetAccount(id); useAuth.getState().clear(); } else setErr(e.message); });
    return () => { dead = true; };
  }, [!!access, tries]); // eslint-disable-line
  useEffect(() => { if (!access) endSession(true); }, [access]);
  if (!access) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (err && !ready) return <Splash error={err} retry={() => { setErr(''); setTries((t) => t + 1); }} />;
  if (!ready) return <Splash />;
  return <><AppShell /><AppEffects /></>;
}

/** Deep links + hardware back + native glue; mounted for logged-out screens too (invite links open on the login page). */
function NativeBridge() {
  const navigate = useNavigate(); const ref = useRef(navigate); ref.current = navigate;
  // register once: re-registering on every navigation would replay the cold-start deep link
  useEffect(() => initNative({ navigate: (to) => ref.current(to), canGoBack: () => window.history.length > 1 && !/^\/channels\/@me\/?$/.test(location.pathname), goBack: () => ref.current(-1) }), []);
  return null;
}

export default function App() {
  useThemeEffects();
  const access = useAuth((s) => s.access);
  const lang = useUI((s) => s.prefs.language);
  setLocale(lang); // silent; the keyed subtree below remounts with the new strings
  useSyncExternalStore(onServerChange, getServerUrl);
  const setup = needsServerSetup(); const loc = useLocation();
  if (setup && loc.pathname !== '/connect' && !loc.pathname.startsWith('/demo')) return <Navigate to={loc.pathname === '/' ? '/connect' : `/connect?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return (
    <div key={lang} className="contents">
      <NativeBridge />
      <Lazy fallback={<Splash />}><Routes>
        <Route path="/connect" element={FIXED_SERVER && (isNative() || isStaticHost()) ? <Navigate to="/login" replace /> : <ServerSetupPage />} />
        <Route path="/login" element={access && !new URLSearchParams(loc.search).has('add') ? <Navigate to="/channels/@me" replace /> : <LoginPage />} />
        <Route path="/register" element={access ? <Navigate to="/channels/@me" replace /> : <RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/verify-email-change" element={<VerifyEmailChangePage />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/template/:code" element={<TemplatePage />} />
        <Route path="/demo/*" element={<DemoPage />} />
        <Route path="/developers/*" element={<DeveloperPortal />} />
        <Route path="/admin" element={access ? <AdminDashboard /> : <Navigate to="/login" replace />} />
        <Route path="/oauth2/authorize" element={<OAuthAuthorize />} />
        <Route path="/discover" element={<Protected />} />
        <Route path="/channels/:guildId/:channelId?/:messageId?" element={<Protected />} />
        <Route path="*" element={<Navigate to="/channels/@me" replace />} />
      </Routes></Lazy>
      <Overlays />
    </div>
  );
}
