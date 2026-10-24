/**
 * Third-party embedded activities: a sandboxed iframe in the voice view plus the launcher shown in the Activities popover.
 * The frame gets no top navigation, no popups, no modals, no forms-to-parent and a single delegated feature (fullscreen);
 * the web CSP only allows framing origins that an app registered (server `frame-src`). All data the app sees flows through
 * the postMessage bridge in `lib/activityHost.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, Puzzle, X } from 'lucide-react';
import { ACTIVITY_ALLOW, ACTIVITY_SANDBOX, activityOrigin, type ActivityParticipant, type ChannelActivity } from '@jorcord/shared';
import { api } from '@/lib/api';
import { activityFrameUrl, createActivityHost } from '@/lib/activityHost';
import { useData } from '@/stores/data';
import { useChannelActivities } from '@/stores/channelActivities';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

/** Members connected to the channel, reduced to what an app may see. */
export function participantsOf(channelId: string, voiceStates: Record<string, { channelId: string | null; selfMute: boolean; selfDeaf: boolean }>, users: Record<string, { id: string; username: string; displayName?: string | null; avatar?: string | null }>): ActivityParticipant[] {
  return Object.entries(voiceStates).filter(([, v]) => v.channelId === channelId).map(([id, v]) => {
    const u = users[id];
    return { id, username: u?.username ?? id, displayName: u?.displayName ?? null, avatar: u?.avatar ?? null, selfMute: v.selfMute, selfDeaf: v.selfDeaf };
  });
}

function AppFrame({ activity }: { activity: ChannelActivity }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [wide, setWide] = useState(false);
  const me = useData((s) => s.me); const voiceStates = useData((s) => s.voiceStates); const users = useData((s) => s.users);
  const upsert = useChannelActivities((s) => s.upsert); const remove = useChannelActivities((s) => s.remove);
  const rawUrl = activity.application?.activityUrl ?? null;
  const origin = rawUrl ? activityOrigin(rawUrl) : null;
  const src = useMemo(() => activityFrameUrl(rawUrl, { hostOrigin: window.location.origin, activity }), [rawUrl, activity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useRef({ activity, participants: [] as ActivityParticipant[], me });
  const participants = useMemo(() => participantsOf(activity.channelId, voiceStates, users), [activity.channelId, voiceStates, users]);
  live.current = { activity, participants, me };
  const canEnd = activity.hostId === me?.id;

  const host = useMemo(() => {
    if (!origin) return null;
    return createActivityHost({
      activityOrigin: origin,
      frameWindow: () => iframe.current?.contentWindow ?? null,
      post: (m, o) => iframe.current?.contentWindow?.postMessage(m, o),
      getActivity: () => live.current.activity,
      getParticipants: () => live.current.participants,
      getViewer: () => { const u = live.current.me; return u ? { id: u.id, username: u.username, displayName: u.displayName ?? null, avatar: u.avatar ?? null } : null; },
      setState: async (state) => { const next = await api.activities.update(live.current.activity.id, state); upsert(next); return { ...next, application: live.current.activity.application }; },
      close: () => { if (live.current.activity.hostId === live.current.me?.id) void api.activities.end(live.current.activity.id).then(() => remove(live.current.activity.id, live.current.activity.channelId)).catch(() => {}); },
    });
  }, [origin, upsert, remove]);

  useEffect(() => {
    if (!host) return;
    const on = (e: MessageEvent) => { void host.onMessage({ data: e.data, origin: e.origin, source: e.source }); };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [host]);
  useEffect(() => { host?.emit('PARTICIPANTS_UPDATE', participants); host?.emit('VOICE_STATE_UPDATE', participants); }, [host, participants]);
  useEffect(() => { host?.emit('ACTIVITY_UPDATE', { id: activity.id, state: activity.state }); }, [host, activity.state, activity.id]);

  const name = activity.application?.name ?? t('App');
  if (!src) return <p role="alert" className="px-3 py-2 text-xs text-danger">{t('This app has no valid https address, so it cannot be shown.')}</p>;
  return (
    <div data-testid="app-activity" className="shrink-0 border-b border-divider/70 bg-[rgb(var(--rail)/0.35)] px-3 py-2">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-2 pb-2">
        <Puzzle size={18} className="shrink-0 text-muted" />
        <span className="truncate text-sm font-semibold text-header">{name}</span>
        <span className="ms-auto flex items-center gap-1">
          <button aria-label={wide ? t('Shrink') : t('Enlarge')} aria-pressed={wide} onClick={() => setWide((v) => !v)} className="flex h-7 w-7 items-center justify-center rounded text-interactive hover:bg-hover">{wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          {canEnd && <button aria-label={t('End')} onClick={() => void api.activities.end(activity.id).then(() => remove(activity.id, activity.channelId)).catch(() => {})} className="flex h-7 w-7 items-center justify-center rounded text-interactive hover:bg-hover"><X size={16} /></button>}
        </span>
      </div>
      <iframe ref={iframe} title={name} src={src} sandbox={ACTIVITY_SANDBOX} allow={ACTIVITY_ALLOW} referrerPolicy="strict-origin" loading="lazy"
        className={cx('mx-auto block w-full max-w-5xl rounded bg-black', wide ? 'h-[70vh]' : 'h-72')} />
    </div>
  );
}

/** Rendered under the call surface: one frame per running third-party activity. */
export function AppActivityView({ channelId }: { channelId: string }) {
  const apps = useChannelActivities((s) => s.byChannel[channelId]);
  const running = (apps ?? []).filter((a) => a.kind === 'app');
  if (!running.length) return null;
  return <>{running.map((a) => <AppFrame key={a.id} activity={a} />)}</>;
}

/** Section of the Activities popover: launch an app installed in this server (or one of your own). */
export function AppActivityLauncher({ channelId }: { channelId: string }) {
  const [apps, setApps] = useState<{ id: string; name: string; description: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const upsert = useChannelActivities((s) => s.upsert);
  const all = useChannelActivities((s) => s.byChannel[channelId]);
  const running = (all ?? []).filter((a) => a.kind === 'app').map((a) => a.applicationId);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.activities.apps(channelId)).then((a) => { if (alive) setApps(a); }).catch(() => { if (alive) setApps([]); });
    return () => { alive = false; };
  }, [channelId]);
  if (!apps?.length) return null;
  const launch = async (id: string) => {
    setBusy(id); setError(null);
    try { upsert(await api.activities.start(channelId, { applicationId: id })); }
    catch (e) { setError((e as Error).message || t('Could not launch the app')); }
    finally { setBusy(null); }
  };
  return (
    <div className="mt-3 border-t border-divider/70 pt-3" data-testid="app-activity-launcher">
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-interactive"><Puzzle size={14} />{t('Apps')}</div>
      {error && <p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      <ul className="grid gap-1.5">
        {apps.map((a) => (
          <li key={a.id}><button className="btn btn-secondary w-full justify-start" disabled={busy !== null || running.includes(a.id)} onClick={() => void launch(a.id)} title={a.description}>{running.includes(a.id) ? t('{name} is running', { name: a.name }) : t('Launch {name}', { name: a.name })}</button></li>
        ))}
      </ul>
    </div>
  );
}
