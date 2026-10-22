import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { VoiceSettingsForm } from '@/voice/VoiceSettings';
import { useQuery } from '@tanstack/react-query';
import { Link2, Accessibility, Bell, Globe, Keyboard, LogOut, Mic, Palette, Shield, User as UserIcon, UserCircle, Monitor, Radio, Laptop, Smile, Code2, Lock, ShieldAlert, Film, Users, Gamepad2 } from 'lucide-react';
import { PrivacyTab } from './PrivacyTab';
import { ConnectionsTab } from './ConnectionsTab';
import { AccountsSection } from './AccountsSection';
import { NotificationsTab, StreamerTab, DesktopTab, ServerSection, ThemePicker, ThemeColorsPicker } from './UserSettingsExtra';
import { isTauri } from '@/lib/server';
import { LOCALES } from '@/i18n';
import { t, T } from '@/i18n';
import { useStreamer, maskEmail } from '@/lib/streamer';
import { profileGradient, isHex, headerBackground, isHexPair, type ThemePair } from '@/lib/profileTheme';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { PasskeysPanel } from './PasskeysPanel';
import { DataPrivacyPanel } from './DataPrivacyPanel';
import { useUI, defaultKeybinds, toast, toastError, type Theme } from '@/stores/ui';
import { SettingsLayout, H1, H3, SaveBar } from './SettingsLayout';
import { Field, Row, Toggle, Spinner } from '@/components/ui/primitives';
import { IconPicker } from '@/components/modals/ModalHost';
import { Avatar } from '@/components/ui/Avatar';
import { cx, fileUrl, idColor } from '@/lib/format';
import { logout } from '@/lib/auth';
import { ProfileCard } from '@/components/modals/Profile';
import { Markdown } from '@/components/chat/Markdown';
import { CosmeticsPicker } from './CosmeticsPicker';
import { ServerProfiles } from './ServerProfiles';
import { pickProfileGif } from '@/lib/profileGif';
import { RegisteredGamesTab } from './RegisteredGamesTab';
import { ProfileEffect, ServerTagBadge, plateClass } from '@/components/ui/Cosmetics';
import { ScanQrDialog } from './ScanQrDialog';

let lastTab = 'account';
export function UserSettings({ initialTab }: { initialTab?: string }) {
  const navigate = useNavigate();
  const [tab, setTabRaw] = useState(initialTab ?? lastTab); const setTab = (x: string) => { lastTab = x; setTabRaw(x); }; const close = () => { lastTab = 'account'; useUI.getState().openSettings(null); };
  // only the configured super admin gets a 200 here; everyone else gets 404 and never sees the entry
  const isAdmin = !!useQuery({ queryKey: ['admin', 'me'], queryFn: api.admin.me, retry: false, staleTime: Infinity }).data?.admin;
  const groups = [
    { title: t('User Settings'), items: [{ id: 'account', label: t('My Account'), icon: UserIcon }, { id: 'profile', label: t('Profile'), icon: UserCircle }, { id: 'profiles', label: t('Profiles'), icon: Users }, { id: 'privacy', label: t('Privacy & Safety'), icon: Lock }, { id: 'connections', label: t('Connections'), icon: Link2 }, { id: 'security', label: t('Security & Devices'), icon: Shield }] },
    { title: t('App Settings'), items: [{ id: 'appearance', label: t('Appearance'), icon: Palette }, { id: 'accessibility', label: t('Accessibility'), icon: Accessibility }, { id: 'voice', label: t('Voice & Video'), icon: Mic }, { id: 'notifications', label: t('Notifications'), icon: Bell }, { id: 'keybinds', label: t('Keybinds'), icon: Keyboard }, { id: 'streamer', label: t('Streamer Mode'), icon: Radio }, { id: 'language', label: t('Language'), icon: Globe }, ...(isTauri() ? [{ id: 'desktop', label: t('Desktop App'), icon: Laptop }, { id: 'registeredGames', label: t('Registered Games'), icon: Gamepad2 }] : [])] },
    { title: t('Developers'), items: [{ id: 'developer', label: t('Developer Portal'), icon: Code2 }] },
    ...(isAdmin ? [{ title: t('Instance'), items: [{ id: 'admin', label: t('Admin Dashboard'), icon: ShieldAlert }] }] : []),
    { items: [{ id: 'logout', label: t('Log Out'), icon: LogOut, danger: true }] },
  ];
  return (
    <SettingsLayout title={t('User Settings')} groups={groups} tab={tab} onTab={(t) => { if (t === 'logout') { logout(); close(); } else if (t === 'developer') { close(); navigate('/developers'); } else if (t === 'admin') { close(); navigate('/admin'); } else setTab(t); }} onClose={close}>
      {tab === 'account' && <Account go={setTab} />}
      {tab === 'profile' && <Profile />}
      {tab === 'profiles' && <ServerProfiles />}
      {tab === 'privacy' && <PrivacyTab />}
      {tab === 'connections' && <ConnectionsTab />}
      {tab === 'security' && <Security />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'accessibility' && <A11y />}
      {tab === 'voice' && <VoiceVideo />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'streamer' && <StreamerTab />}
      {tab === 'desktop' && <DesktopTab />}
      {tab === 'registeredGames' && <RegisteredGamesTab />}
      {tab === 'keybinds' && <Keybinds />}
      {tab === 'language' && <Language />}
    </SettingsLayout>
  );
}

function Account({ go }: { go: (t: string) => void }) {
  const me = useData((s) => s.me)!; const [pw, setPw] = useState({ cur: '', next: '' }); const [busy, setBusy] = useState(false); const st = useStreamer();
  return (<>
    <H1>{t('My Account')}</H1>
    <div className="overflow-hidden rounded-lg bg-side"><div className="h-24" style={{ background: headerBackground(me, me.banner ? fileUrl(me.banner) : null, idColor(me.id)) }} />
      <div className="flex items-center gap-4 px-4 pb-4"><div className="-mt-8 rounded-full border-[6px] border-[rgb(var(--side))]"><Avatar user={me} size={80} presence /></div><div className="mt-2 text-xl font-bold text-header">{me.displayName || me.username}</div><button className="btn btn-primary ms-auto" onClick={() => go('profile')}>{t('Edit User Profile')}</button></div>
      <dl className="m-4 space-y-4 rounded-lg bg-[rgb(var(--modal-alt))] p-4"><div><dt className="label !mb-0.5">{t('Username')}</dt><dd className="text-header">{me.username}</dd></div><div><dt className="label !mb-0.5">{t('Email')}</dt><dd className="text-header" data-testid="account-email">{st.hidePersonal ? maskEmail(me.email) : me.email}{!me.verified && <span className="ms-2 text-xs text-warn">unverified</span>}</dd></div></dl></div>
    <ServerSection />
    <AccountsSection />
    <H3>{t('Password')}</H3>
    <form className="max-w-sm" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api.auth.password({ currentPassword: pw.cur, newPassword: pw.next }); toast(t('Password changed'), 'success'); setPw({ cur: '', next: '' }); } catch (err) { toastError(err); } setBusy(false); }}>
      <Field label={t('Current Password')}><input type="password" autoComplete="current-password" className="field" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} /></Field>
      <Field label={t('New Password')}><input type="password" autoComplete="new-password" className="field" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} minLength={8} /></Field>
      <button disabled={busy || pw.next.length < 8 || !pw.cur} className="btn btn-primary btn-lg">{t('Change Password')}</button>
    </form>
    <DataPrivacyPanel />
  </>);
}

function Profile() {
  const me = useData((s) => s.me)!;
  const init = { displayName: me.displayName ?? '', pronouns: me.pronouns ?? '', bio: me.bio ?? '', avatar: me.avatar, banner: me.banner, accentColor: me.accentColor ?? '#5865f2', themeColors: (isHexPair(me.themeColors) ? me.themeColors : null) as ThemePair | null, avatarDecoration: me.avatarDecoration ?? null, profileEffect: me.profileEffect ?? null, namePlate: me.namePlate ?? null, serverTagGuildId: me.serverTag?.guildId ?? null };
  const [f, setF] = useState(init); const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const save = async () => { setBusy(true); try { const u = await api.users.patchMe({ displayName: f.displayName || null, pronouns: f.pronouns || null, bio: f.bio || null, avatar: f.avatar, banner: f.banner, accentColor: f.accentColor, themeColors: f.themeColors, avatarDecoration: f.avatarDecoration, profileEffect: f.profileEffect, namePlate: f.namePlate, serverTagGuildId: f.serverTagGuildId }); useData.getState().apply('USER_UPDATE', { ...me, ...u }); toast(t('Profile saved'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const pickGif = (kind: 'avatar' | 'banner') => pickProfileGif(kind, (u) => setF((x) => ({ ...x, [kind]: u })));
  return (<>
    <H1>{t('Profile')}</H1>
    <div className="flex flex-col gap-8 lg:flex-row"><div className="min-w-0 flex-1">
      <Field label={t('Display Name')}><input className="field" value={f.displayName} maxLength={32} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={me.username} /></Field>
      <Field label={t('Pronouns')}><input className="field" value={f.pronouns} maxLength={40} onChange={(e) => setF({ ...f, pronouns: e.target.value })} placeholder={t('Add your pronouns')} /></Field>
      <div className="mb-4"><span className="label">{t('Avatar')}</span><div className="flex flex-wrap items-center gap-2"><IconPicker value={f.avatar} onChange={(v) => setF({ ...f, avatar: v })} size={72} label={t('Avatar')} /><button type="button" className="btn btn-secondary" onClick={() => pickGif('avatar')}><Film size={16} />{t('Choose GIF')}</button></div><span className="mt-1 block text-xs text-muted">{t('GIF and animated WebP avatars and banners are supported.')}</span></div>
      <div className="mb-4"><span className="label">{t('Banner')}</span><div className="relative h-24 overflow-hidden rounded-lg" style={{ background: f.banner ? `center/cover url(${fileUrl(f.banner)})` : f.accentColor }}><label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 text-sm font-semibold text-white opacity-0 hover:opacity-100 focus-within:opacity-100">{t('Change banner')}<input type="file" accept="image/*" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { const url = await api.files.uploadImage(file); setF((s) => ({ ...s, banner: url })); } catch (err) { toastError(err); } }} /></label></div><div className="mt-1 flex items-center gap-3"><button type="button" className="btn btn-secondary" onClick={() => pickGif('banner')}><Film size={16} />{t('Choose GIF')}</button>{f.banner && <button className="text-sm text-link" onClick={() => setF({ ...f, banner: null })}>{t('Remove banner')}</button>}</div></div>
      <ThemePicker value={f.accentColor} onChange={(c) => setF({ ...f, accentColor: c })} />
      <ThemeColorsPicker value={f.themeColors} onChange={(c) => setF({ ...f, themeColors: c })} />
      <CosmeticsPicker me={me} value={f} onChange={(v) => setF({ ...f, ...v })} />
      <div className="mb-4"><span className="label">{t('Custom Status')}</span><button type="button" className="btn btn-secondary" onClick={() => useUI.getState().openModal({ kind: 'customStatus' })}><Smile size={16} />{me.customStatus?.text || me.customStatus?.emoji ? `${me.customStatus.emoji ?? ''} ${me.customStatus.text ?? ''}`.trim() : t('Set a custom status')}</button></div>
      <Field label={t('About Me')} hint={t('You can use markdown and links.')}><textarea className="field min-h-[110px]" value={f.bio} maxLength={190} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
    </div>
    <div className="lg:w-[300px]"><span className="label">{t('Preview')}</span><div className="pointer-events-none"><PreviewCard me={me} f={f} /></div></div></div>
    <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF(init)} />
  </>);
}
function PreviewCard({ me, f }: { me: any; f: any }) {
  const tg = useData((s) => (f.serverTagGuildId ? s.guilds[f.serverTagGuildId]?.guild : undefined));
  return <div className="overflow-hidden rounded-lg bg-[rgb(var(--modal-alt))]"><div className="relative h-[60px]" data-testid="preview-banner" style={{ background: headerBackground({ banner: f.banner, themeColors: f.themeColors, accentColor: f.accentColor }, f.banner ? fileUrl(f.banner) : null, f.accentColor) }}><ProfileEffect id={f.profileEffect} /></div>
    <div className="px-4 pb-4"><div className="-mt-10 mb-2 w-fit rounded-full border-[6px] border-[rgb(var(--modal-alt))]"><Avatar user={{ ...me, avatar: f.avatar }} size={80} decoration={f.avatarDecoration} /></div>
      <div className="rounded-lg bg-[rgb(var(--rail)/0.5)] p-3"><div className={`text-xl font-bold text-header ${plateClass(f.namePlate)} ${f.namePlate ? 'px-2 py-1 -mx-1' : ''}`} data-testid="preview-name">{f.displayName || me.username}{tg?.tag && <> <ServerTagBadge tag={{ guildId: tg.id, tag: tg.tag, badge: tg.tagBadge ?? null }} /></>}</div><div className="text-sm">{me.username}{f.pronouns && <span className="text-muted"> • {f.pronouns}</span>}</div>{(me.customStatus?.text || me.customStatus?.emoji) && <div className="mt-1 text-sm" data-testid="preview-status">{me.customStatus.emoji} {me.customStatus.text}</div>}{f.bio && <><hr className="my-3 border-divider" /><div className="text-xs font-bold uppercase text-header">{t('About Me')}</div><div className="text-sm"><Markdown content={f.bio} /></div></>}</div></div></div>;
}

function Security() {
  const me = useData((s) => s.me)!; const [setup, setSetup] = useState<{ secret: string; uri?: string; qr?: string } | null>(null); const [code, setCode] = useState(''); const [rec, setRec] = useState<string[] | null>(null); const [scanning, setScanning] = useState(false);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.auth.sessions, retry: false });
  const refresh = () => api.users.me().then((u) => useData.getState().setMe(u)).catch(() => {});
  return (<>
    <H1>{t('Security & Devices')}</H1>
    <H3>{t('Two-Factor Authentication')}</H3>
    {me.mfaEnabled ? (<div className="rounded-lg bg-side p-4"><p className="mb-3 text-header">Two-factor authentication is <b className="text-success">enabled</b>.</p>
      <div className="flex gap-2"><input className="field !w-40" placeholder="6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('Authentication code')} /><button className="btn btn-danger" disabled={code.length < 6} onClick={() => api.auth.mfaDisable(code).then(() => { toast('2FA disabled', 'success'); setCode(''); refresh(); }).catch(toastError)}>{t('Disable 2FA')}</button></div></div>
    ) : setup ? (<div className="rounded-lg bg-side p-4"><p className="mb-2 text-sm">{t('Add this secret to your authenticator app, then enter the 6-digit code.')}</p>
      {setup.qr && <img src={setup.qr} alt="2FA QR code" className="mb-2 h-40 w-40 rounded bg-white p-2" />}
      <code className="mb-3 block break-all rounded bg-rail p-2 text-sm">{setup.secret}</code>
      <div className="flex gap-2"><input className="field !w-40" placeholder="6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('Authentication code')} /><button className="btn btn-primary" disabled={code.length < 6} onClick={() => api.auth.mfaEnable(code).then((r) => { setRec(r.recoveryCodes ?? null); setSetup(null); setCode(''); toast('2FA enabled', 'success'); refresh(); }).catch(toastError)}>{t('Enable')}</button></div></div>
    ) : <button className="btn btn-primary btn-lg" onClick={() => api.auth.mfaSetup().then((r) => setSetup({ secret: r.secret, uri: r.uri ?? r.otpauthUrl, qr: r.qr })).catch(toastError)}>{t('Enable Authenticator App')}</button>}
    {rec && <div className="mt-3 rounded-lg bg-side p-4"><p className="mb-2 font-semibold text-header">{t('Recovery codes — save these now')}</p><pre className="font-mono text-sm">{rec.join('\n')}</pre></div>}
    <PasskeysPanel />
    <H3>{t('Log in on another device')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Open Jorcord on a computer or browser, then scan the QR code on its login page to sign it in without typing a password.')}</p>
    <button className="btn btn-secondary" onClick={() => setScanning(true)}>{t('Scan QR code')}</button>
    {scanning && <ScanQrDialog onClose={() => { setScanning(false); void sessions.refetch(); }} />}
    <H3>{t('Devices')}</H3>
    {sessions.isLoading && <Spinner />}
    <ul>{sessions.data?.map((s: any, i: number) => <li key={s.id ?? i} className="flex items-center gap-3 border-b border-divider/50 py-3"><Monitor size={22} className="text-muted" /><div className="min-w-0 flex-1"><div className="truncate text-header">{s.userAgent ?? s.device ?? 'Unknown device'}{s.current && <span className="ms-2 rounded bg-success px-1 text-[10px] font-bold text-white">{t('THIS DEVICE')}</span>}</div><div className="text-xs text-muted">{s.ip} {s.lastUsedAt && `• ${new Date(s.lastUsedAt).toLocaleString()}`}</div></div>{!s.current && <button className="btn btn-secondary" onClick={() => api.auth.revokeSession(s.id).then(() => sessions.refetch()).catch(toastError)}>{t('Log out')}</button>}</li>)}</ul>
  </>);
}

function Appearance() {
  const prefs = useUI((s) => s.prefs); const set = useUI((s) => s.setPref); const me = useData((s) => s.me);
  const themes: { id: Theme; label: string; bg: string; fg: string }[] = [{ id: 'dark', label: T('Dark'), bg: '#313338', fg: '#2b2d31' }, { id: 'light', label: T('Light'), bg: '#ffffff', fg: '#f2f3f5' }, { id: 'amoled', label: T('AMOLED'), bg: '#000000', fg: '#080809' }];
  const pick = (t: Theme) => {
    set('theme', t);
    // keep the account copy in sync too (SelfUser.theme is what a fresh device uses)
    api.users.patchMe({ theme: t }).then((u) => { const cur = useData.getState().me; if (cur) useData.getState().setMe({ ...cur, theme: u?.theme ?? t }); }).catch(() => {});
  };
  return (<>
    <H1>{t('Appearance')}</H1>
    <H3>{t('Theme')}</H3>
    <div role="radiogroup" aria-label={t('Theme')} className="grid grid-cols-3 gap-3">{themes.map((th) => <button key={th.id} role="radio" aria-checked={prefs.theme === th.id} onClick={() => pick(th.id)} className={cx('overflow-hidden rounded-lg border-2 text-start', prefs.theme === th.id ? 'border-brand' : 'border-divider')}>
      <div className="flex h-20" style={{ background: th.bg }}><div className="w-1/4" style={{ background: th.id === 'light' ? '#e3e5e8' : th.id === 'amoled' ? '#000' : '#1e1f22' }} /><div className="w-1/3" style={{ background: th.fg }} /><div className="flex-1 space-y-1.5 p-2"><div className="h-2 w-3/4 rounded" style={{ background: '#5865f2' }} /><div className="h-2 w-1/2 rounded bg-gray-500/50" /></div></div>
      <div className="bg-side px-3 py-2 text-sm font-semibold text-header">{t(th.label)}</div></button>)}</div>
    <H3>{t('Message Display')}</H3>
    <div role="radiogroup" aria-label={t('Message display')} className="grid gap-2 sm:grid-cols-2">{(['cozy', 'compact'] as const).map((d) => <label key={d} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border-2 p-3', prefs.density === d ? 'border-brand' : 'border-divider')}><input type="radio" name="den" className="accent-brand" checked={prefs.density === d} onChange={() => set('density', d)} /><span className="font-semibold capitalize text-header">{d}</span></label>)}</div>
    <H3>{t('Chat Font Scaling')}</H3>
    <input type="range" min={0.85} max={1.4} step={0.05} value={prefs.fontScale} onChange={(e) => set('fontScale', Number(e.target.value))} aria-label={t('Font scale')} className="w-full accent-brand" /><div className="text-sm text-muted">{Math.round(prefs.fontScale * 100)}%</div>
    <H3>{t('Preview')}</H3>
    <div className="rounded-lg bg-chat p-3 ring-1 ring-divider"><div className="flex gap-3"><Avatar user={me} size={40} /><div><div className="font-medium text-header">{me?.displayName || me?.username} <span className="text-xs text-muted">{t('Today')}</span></div><div>{t('Looks great at this size.')}</div></div></div></div>
  </>);
}

function A11y() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  return (<><H1>{t('Accessibility')}</H1>
    <Row title={t('Reduce Motion')} desc={t('Disable animations and transitions. Also follows your system setting.')}><Toggle label={t('Reduce motion')} checked={p.reducedMotion} onChange={(v) => set('reducedMotion', v)} /></Row>
    <Row title={t('Autoplay GIFs')} desc={t('Play animated images automatically.')}><Toggle label={t('Autoplay GIFs')} checked={p.autoplayGifs} onChange={(v) => set('autoplayGifs', v)} /></Row>
    <Row title={t('Show embeds and link previews')} desc={t('Show website previews for links in chat.')}><Toggle label={t('Show embeds')} checked={p.showEmbeds} onChange={(v) => set('showEmbeds', v)} /></Row>
    <Row title={t('Increased contrast')} desc={t('Boost text contrast.')}><Toggle label={t('High contrast')} checked={p.highContrast} onChange={(v) => set('highContrast', v)} /></Row>
    <Row title="24-hour time"><Toggle label="24 hour time" checked={p.twentyFourHour} onChange={(v) => set('twentyFourHour', v)} /></Row>
    <H3>{t('Text size')}</H3><input type="range" min={0.85} max={1.4} step={0.05} value={p.fontScale} onChange={(e) => set('fontScale', Number(e.target.value))} aria-label={t('Font scale')} className="w-full accent-brand" />
  </>);
}

function VoiceVideo() {
  return (<><H1>{t('Voice & Video')}</H1><VoiceSettingsForm /></>);
}

const LABELS: Record<string, string> = { quickSwitcher: T('Quick Switcher'), markRead: T('Mark Channel Read'), prevChannel: T('Previous Channel'), nextChannel: T('Next Channel'), prevServer: T('Previous Server'), nextServer: T('Next Server'), toggleMembers: T('Toggle Member List'), search: T('Search'), shortcuts: T('Show Shortcuts'), pushToTalk: T('Push to Talk'), toggleMute: T('Toggle Mute'), toggleDeafen: T('Toggle Deafen') };
export { comboFromEvent } from '@/lib/combo';
import { comboFromEvent } from '@/lib/combo';
function Keybinds() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref); const [rec, setRec] = useState<string | null>(null);
  useEffect(() => { if (!rec) return; const h = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); const c = comboFromEvent(e); if (e.key === 'Escape') { setRec(null); return; } if (c) { set('keybinds', { ...p.keybinds, [rec]: c }); setRec(null); } }; window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true); }, [rec, p.keybinds, set]);
  return (<><div className="mb-5 flex items-center justify-between"><h1 className="text-xl font-bold text-header">{t('Keybinds')}</h1><button className="btn btn-secondary" onClick={() => set('keybinds', defaultKeybinds)}>{t('Reset to defaults')}</button></div>
    <ul>{Object.keys(LABELS).map((k) => <li key={k} className="flex items-center justify-between border-b border-divider/60 py-3"><span className="font-medium text-header">{t(LABELS[k]!)}</span><button onClick={() => setRec(rec === k ? null : k)} aria-label={`Change keybind for ${LABELS[k]}`} className={cx('min-w-[110px] rounded bg-rail px-3 py-1.5 font-mono text-sm', rec === k ? 'ring-2 ring-danger text-danger' : 'text-header')}>{rec === k ? 'Press keys…' : p.keybinds[k] ?? defaultKeybinds[k]}</button></li>)}</ul></>);
}

function Language() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  return (<><H1>{t('Language')}</H1><p className="mb-4 text-sm text-muted">{t('Dates, times, and number formats follow this language. Messages written by people are never translated.')}</p>
    <div role="radiogroup" aria-label={t('Language')} className="grid gap-2">{LOCALES.map((l) => <label key={l.tag} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border-2 p-3', p.language === l.tag ? 'border-brand' : 'border-divider')}><input type="radio" className="accent-brand" name="lang" checked={p.language === l.tag} onChange={() => set('language', l.tag)} /><span className="font-medium text-header" lang={l.tag} dir={l.dir}>{l.label}</span></label>)}</div></>);
}
void ProfileCard;
