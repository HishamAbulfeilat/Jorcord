import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Smartphone, Globe, Trash2, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { useNotif } from '@/stores/notif';
import { H1, H3 } from './SettingsLayout';
import { Row, Toggle, Spinner } from '@/components/ui/primitives';
import { cx, fmtStamp } from '@/lib/format';
import { disablePush, enablePush, loadPushState, pushSupport } from '@/lib/push';
import { desktop } from '@/lib/native';
import { getServerUrl, isNative, nativePlatform } from '@/lib/server';
import { switchServer } from '@/lib/serverSwitch';
import { PROFILE_THEMES, THEME_PAIRS, themeGradient, type ThemePair } from '@/lib/profileTheme';
import { useStreamer } from '@/lib/streamer';
import { t, T } from '@/i18n';

/* ------------------------------------------------------------------ notifications */
const DEVICE_ICON = { web: Globe, desktop: Monitor, android: Smartphone, ios: Smartphone } as const;
export function NotificationsTab() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref);
  const notif = useNotif(); const support = pushSupport();
  const [thisDevice, setThisDevice] = useState(() => !!loadPushState()?.enabled); const [busy, setBusy] = useState(false);
  const devices = useQuery({ queryKey: ['push-devices'], queryFn: api.push.devices, retry: false });
  useEffect(() => { void notif.load(); }, []); // eslint-disable-line
  const enableDesktop = async (v: boolean) => {
    if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission(); if (r !== 'granted') { toast(t('Notifications are blocked in your browser settings.'), 'error'); return; }
    }
    set('desktopNotifications', v);
  };
  const togglePush = async (v: boolean) => {
    setBusy(true);
    if (v) { const r = await enablePush(); if (r.ok) { setThisDevice(true); toast(t('Push notifications enabled on this device'), 'success'); } else toast(r.reason, 'error'); }
    else { await disablePush(); setThisDevice(false); }
    await devices.refetch(); setBusy(false);
  };
  return (<>
    <H1>{t('Notifications')}</H1>
    <Row title={t('Enable Desktop Notifications')} desc={t('Get notified of new messages when Jorcord is in the background.')}><Toggle label={t('Desktop notifications')} checked={p.desktopNotifications} onChange={enableDesktop} /></Row>
    <Row title={t('Message Sounds')}><Toggle label={t('Sounds')} checked={p.notificationSounds} onChange={(v) => set('notificationSounds', v)} /></Row>
    <Row title={t('Suppress @everyone and @here')}><Toggle label={t('Suppress everyone')} checked={p.suppressEveryone} onChange={(v) => set('suppressEveryone', v)} /></Row>

    <H3>{t('Push Notifications')}</H3>
    <Row title={t('Receive push notifications')} desc={t('Turn off to stop all push notifications to every device. Messages still arrive in the app.')}><Toggle label={t('Receive push notifications')} checked={notif.pushEnabled} onChange={(v) => void notif.setPushEnabled(v)} /></Row>
    <Row title={t('Push on this device')} desc={support.kind === 'none' ? support.reason : isNative() ? t('Registers this app with your server so it can wake it for new messages.') : t('Uses your browser to show notifications even when Jorcord is closed.')}>
      <Toggle label={t('Push on this device')} checked={thisDevice} disabled={support.kind === 'none' || busy} onChange={togglePush} />
    </Row>
    <H3>{t('Registered devices')}</H3>
    {devices.isLoading && <Spinner />}
    {devices.isError && <p className="text-sm text-muted">{t('This server does not support push notifications.')}</p>}
    {devices.data && !devices.data.length && <p className="text-sm text-muted" data-testid="no-devices">{t('No devices are registered for push yet.')}</p>}
    <ul aria-label={t('Registered devices')}>{devices.data?.map((d) => { const I = DEVICE_ICON[d.platform] ?? Globe; return (
      <li key={d.id} data-device={d.id} className="flex items-center gap-3 border-b border-divider/50 py-3"><I size={22} className="text-muted" />
        <div className="min-w-0 flex-1"><div className="truncate text-header">{d.platform}{d.current && <span className="ms-2 rounded bg-success px-1 text-[10px] font-bold text-white">{t('THIS DEVICE')}</span>}</div><div className="text-xs text-muted">{t('Added')} {d.createdAt ? fmtStamp(new Date(d.createdAt).getTime()) : ''}</div></div>
        <button aria-label={t('Remove device')} className="p-2 text-danger" onClick={() => api.push.removeDevice(d.id).then(() => { if (d.current) { void disablePush({ keepSubscription: false }); setThisDevice(false); } return devices.refetch(); }).catch(toastError)}><Trash2 size={16} /></button></li>); })}</ul>

    <H3>{t('Default notification setting for new servers')}</H3>
    <div role="radiogroup" className="grid gap-2">{([['all', T('All Messages')], ['mentions', T('Only @mentions')], ['none', T('Nothing')]] as const).map(([v, l]) => <label key={v} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border-2 p-3', p.defaultNotify === v ? 'border-brand' : 'border-divider')}><input type="radio" className="accent-brand" name="dn" checked={p.defaultNotify === v} onChange={() => set('defaultNotify', v)} /><span className="font-medium text-header">{t(l)}</span></label>)}</div>
    <ServerOverrides />
  </>);
}

function ServerOverrides() {
  const guilds = useData((s) => s.guilds); const gs = useNotif((s) => s.guilds); const open = useUI((s) => s.openModal);
  const rows = Object.entries(gs).filter(([id, r]) => guilds[id] && (r.muted || r.level || r.suppressEveryone || r.suppressRoles));
  if (!rows.length) return null;
  return (<>
    <H3>{t('Servers with custom settings')}</H3>
    <ul>{rows.map(([id, r]) => <li key={id} className="flex items-center gap-3 border-b border-divider/50 py-3"><span className="min-w-0 flex-1 truncate font-medium text-header">{guilds[id]!.guild.name}</span><span className="text-xs text-muted">{r.muted ? t('Muted') : r.level ? t(r.level === 'all' ? T('All Messages') : r.level === 'mentions' ? T('Only @mentions') : T('Nothing')) : ''}</span><button className="btn btn-secondary" onClick={() => open({ kind: 'notifSettings', scope: 'guild', id })}>{t('Edit')}</button></li>)}</ul>
  </>);
}

/* ------------------------------------------------------------------ streamer mode */
export function StreamerTab() {
  const p = useUI((s) => s.prefs); const set = useUI((s) => s.setPref); const st = useStreamer();
  return (<>
    <H1>{t('Streamer Mode')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Streamer Mode hides sensitive information while you broadcast or record your screen.')}</p>
    <Row title={t('Enable Streamer Mode')} desc={st.on && !p.streamerMode ? t('Active right now because you are sharing your screen.') : undefined}><Toggle label={t('Enable Streamer Mode')} checked={p.streamerMode} onChange={(v) => set('streamerMode', v)} /></Row>
    <Row title={t('Automatically enable when I Go Live')} desc={t('Turns on while you are sharing your screen in a voice channel.')}><Toggle label={t('Automatically enable when I Go Live')} checked={p.streamerAuto} onChange={(v) => set('streamerAuto', v)} /></Row>
    <H3>{t('While Streamer Mode is on')}</H3>
    <Row title={t('Hide personal information')} desc={t('Blur your email address and other private account details.')}><Toggle label={t('Hide personal information')} checked={p.streamerHidePersonal} onChange={(v) => set('streamerHidePersonal', v)} /></Row>
    <Row title={t('Hide invite links')} desc={t('Blur invite and webhook links so viewers cannot copy them.')}><Toggle label={t('Hide invite links')} checked={p.streamerHideInvites} onChange={(v) => set('streamerHideInvites', v)} /></Row>
    <Row title={t('Disable sounds')}><Toggle label={t('Disable sounds')} checked={p.streamerNoSounds} onChange={(v) => set('streamerNoSounds', v)} /></Row>
    <Row title={t('Disable notifications')} desc={t('Desktop notifications will not pop up on stream.')}><Toggle label={t('Disable notifications')} checked={p.streamerNoNotifications} onChange={(v) => set('streamerNoNotifications', v)} /></Row>
  </>);
}

/* ------------------------------------------------------------------ desktop app (Tauri) */
export function DesktopTab() {
  const [auto, setAuto] = useState<boolean | null>(null); const [upd, setUpd] = useState<'idle' | 'checking' | 'none' | { version: string; install: () => Promise<void> }>('idle');
  useEffect(() => { void desktop.autostart().then(setAuto); }, []);
  return (<>
    <H1>{t('Desktop App')}</H1>
    <Row title={t('Launch at login')} desc={t('Start Jorcord minimized in the tray when you sign in to your computer.')}>
      <Toggle label={t('Launch at login')} checked={!!auto} disabled={auto === null} onChange={(v) => desktop.setAutostart(v).then(() => setAuto(v)).catch(toastError)} />
    </Row>
    <Row title={t('Software updates')} desc={typeof upd === 'object' ? t('Version {v} is available.', { v: upd.version }) : upd === 'none' ? t('You are up to date.') : t('Check for a newer version of the desktop app.')}>
      {typeof upd === 'object'
        ? <button className="btn btn-primary" onClick={() => void upd.install().catch(toastError)}>{t('Install and restart')}</button>
        : <button className="btn btn-secondary" disabled={upd === 'checking'} onClick={() => { setUpd('checking'); desktop.checkUpdate().then((u) => setUpd(u ?? 'none')).catch((e) => { setUpd('idle'); toastError(e); }); }}>{upd === 'checking' ? <Spinner size={14} /> : t('Check for updates')}</button>}
    </Row>
    <p className="mt-4 text-xs text-muted">{t('Closing the window hides Jorcord to the tray. Use the tray menu to quit.')}</p>
  </>);
}

/* ------------------------------------------------------------------ server (wrappers) */
export function ServerSection() {
  const url = getServerUrl(); const open = useUI((s) => s.openModal);
  if (!isNative() && !url) return null;
  return (<>
    <H3>{t('Server')}</H3>
    <div className="flex items-center gap-3 rounded-lg bg-side p-4" data-testid="server-section">
      <div className="min-w-0 flex-1"><div className="label !mb-0.5">{t('Connected to')}</div><div className="truncate text-header">{url || location.origin}</div><div className="text-xs text-muted">{nativePlatform() ?? 'web'}</div></div>
      <button className="btn btn-secondary" onClick={() => open({ kind: 'confirm', title: t('Change server'), body: t('You will be signed out of this server and asked for a new address.'), confirmLabel: t('Change server'), onConfirm: () => { useUI.getState().openSettings(null); switchServer(null); } })}>{t('Change server')}</button>
    </div>
  </>);
}

/* ------------------------------------------------------------------ profile themes */
/** Two-colour theme: presets + two free colour inputs; `null` = off (single accent colour applies). */
export function ThemeColorsPicker({ value, onChange }: { value: ThemePair | null; onChange: (c: ThemePair | null) => void }) {
  const cur: ThemePair = value ?? ['#5865f2', '#eb459e'];
  return (
    <div className="mb-4" data-testid="theme-colors">
      <span className="label">{t('Gradient Theme')}</span>
      <p className="-mt-1 mb-2 text-xs text-muted">{t('Two colours blended across your profile card. Overrides the single colour above.')}</p>
      <div role="radiogroup" aria-label={t('Gradient Theme')} className="mb-2 flex flex-wrap gap-2">
        {THEME_PAIRS.map((th) => { const on = !!value && value[0].toLowerCase() === th.colors[0] && value[1].toLowerCase() === th.colors[1]; return (
          <button key={th.id} type="button" role="radio" aria-checked={on} aria-label={th.name} title={th.name} onClick={() => onChange(th.colors)} className={cx('flex h-10 w-16 items-center justify-center rounded-md border-2', on ? 'border-header' : 'border-transparent')} style={{ background: themeGradient(th.colors) }}>{on && <Check size={16} className="text-white" />}</button>); })}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-interactive">
        <label className="flex items-center gap-2">{t('Primary')}<input type="color" value={cur[0]} onChange={(e) => onChange([e.target.value, cur[1]])} className="h-9 w-12 cursor-pointer rounded bg-transparent" aria-label={t('Primary colour')} /></label>
        <label className="flex items-center gap-2">{t('Accent')}<input type="color" value={cur[1]} onChange={(e) => onChange([cur[0], e.target.value])} className="h-9 w-12 cursor-pointer rounded bg-transparent" aria-label={t('Accent colour')} /></label>
        {value && <button type="button" className="text-link hover:underline" onClick={() => onChange(null)}>{t('Remove gradient')}</button>}
      </div>
    </div>
  );
}

export function ThemePicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="mb-4">
      <span className="label">{t('Profile Theme')}</span>
      <div role="radiogroup" aria-label={t('Profile Theme')} className="flex flex-wrap gap-2">
        {PROFILE_THEMES.map((th) => (
          <button key={th.id} role="radio" aria-checked={value.toLowerCase() === th.color} aria-label={th.name} title={th.name} onClick={() => onChange(th.color)}
            className={cx('flex h-10 w-16 items-center justify-center rounded-md border-2', value.toLowerCase() === th.color ? 'border-header' : 'border-transparent')} style={{ background: `linear-gradient(135deg, ${th.color}, color-mix(in srgb, ${th.color} 55%, black))` }}>
            {value.toLowerCase() === th.color && <Check size={16} className="text-white" />}
          </button>))}
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-14 cursor-pointer rounded bg-transparent" aria-label={t('Custom color')} />
      </div>
    </div>
  );
}
