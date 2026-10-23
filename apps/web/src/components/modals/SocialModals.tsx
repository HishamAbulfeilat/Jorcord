/** Social-layer modals: Inbox (mentions), later saved items and reminders. */
import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, BellRing, AtSign, CalendarClock, Bookmark, Hash, Paperclip, Pencil, Trash2, Users, ShieldBan } from 'lucide-react';
import type { DigestEntry, Id, Message, Report, ScheduledMessage, ReportReason, ReportStatus } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { Perm } from '@jorcord/shared';
import { myChannelPerms } from '@/lib/session';
import { Avatar } from '@/components/ui/Avatar';
import { useSocial } from '@/stores/social';
import { dmName, fmtStamp } from '@/lib/format';
import { goto } from '@/lib/menus';
import { Modal, Tabs, Spinner, Empty } from '@/components/ui/primitives';
import { ResultCard } from '@/components/chat/Panels';
import { t } from '@/i18n';

type InboxTab = 'mentions' | 'digest' | 'saved' | 'reminders' | 'scheduled';

function MentionsList({ close }: { close: () => void }) {
  const guilds = useData((s) => s.guilds);
  const [onlyMine, setOnlyMine] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ['inbox', 'mentions', onlyMine], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.users.mentions({ before: pageParam, limit: 25, ...(onlyMine ? { roles: false, everyone: false } : {}) }),
    getNextPageParam: (last) => (last.length >= 25 ? last[last.length - 1]!.id : undefined),
  });
  const muted = useUI((s) => s.prefs.mutedGuilds);
  const items: Message[] = (q.data?.pages.flat() ?? []).filter((m) => !(m.guildId && muted[m.guildId]));
  return (
    <div>
      <label className="mb-3 flex items-center gap-2 text-sm text-interactive"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />{t('Only direct @mentions (no roles or @everyone)')}</label>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {!q.isLoading && items.length === 0 && <Empty icon={<AtSign size={40} />} title={t('No recent mentions')}>{t('When someone @mentions you, it shows up here.')}</Empty>}
      <ul aria-label={t('Mentions')}>
        {items.map((m) => (
          <li key={m.id} data-inbox-item={m.id}>
            <div className="mb-1 ps-1 text-xs font-semibold text-muted">{m.guildId ? `${guilds[m.guildId]?.guild.name ?? ''}` : t('Direct Message')}</div>
            <ResultCard m={m} onOpen={close} channel={m.guildId ? guilds[m.guildId]?.channels[m.channelId] : undefined} />
          </li>
        ))}
      </ul>
      {q.hasNextPage && <button className="btn btn-secondary mx-auto mt-2 block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('Load more')}</button>}
    </div>
  );
}

/** Quiet mode: batches of notifications that were held back instead of pinging. Counts only; the messages themselves stay in their channels. */
function DigestList({ close }: { close: () => void }) {
  const guilds = useData((s) => s.guilds); const dms = useData((s) => s.dms); const me = useData((s) => s.me?.id); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inbox', 'digest'], queryFn: () => api.digest.list({ limit: 25 }), retry: false });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['inbox', 'digest'] }); void qc.invalidateQueries({ queryKey: ['digest-prefs'] }); };
  const label = (it: DigestEntry['items'][number]) => {
    const g = it.guildId ? guilds[it.guildId] : undefined;
    if (!it.guildId) { const d = dms[it.channelId]; return { where: t('Direct Message'), name: d ? dmName(d, me) : t('a conversation') }; }
    return { where: g?.guild.name ?? t('a server'), name: `#${g?.channels[it.channelId]?.name ?? t('channel')}` };
  };
  const unread = q.data?.filter((e) => !e.readAt).length ?? 0;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-sm text-muted">
        <span>{t('Servers and channels set to "Add to my digest" collect here instead of pinging you.')}</span>
        {unread > 0 && <button className="btn btn-secondary shrink-0" onClick={() => void api.digest.markAllRead().then(refresh).catch(toastError)}>{t('Mark all read')}</button>}
      </div>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {q.isError && <p className="text-sm text-muted">{t('This server does not support notification digests.')}</p>}
      {!q.isLoading && !q.isError && !q.data?.length && <Empty icon={<BellRing size={40} />} title={t('No digests yet')}>{t('Turn on "Add to my digest" in a server or channel\'s notification settings.')}</Empty>}
      <ul aria-label={t('Notification digests')}>
        {q.data?.map((e) => (
          <li key={e.id} data-inbox-item={e.id} className={`mb-3 rounded-lg p-3 ${e.readAt ? 'bg-side' : 'bg-side ring-1 ring-brand'}`}>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted">
              <span className="font-semibold text-header">{t('{n} notifications', { n: e.total })}</span><span>{fmtStamp(new Date(e.periodStart).getTime())} – {fmtStamp(new Date(e.periodEnd).getTime())}</span>
              <span className="ms-auto flex gap-2">
                {!e.readAt && <button className="hover:text-header" onClick={() => void api.digest.markRead(e.id).then(refresh).catch(toastError)}>{t('Mark read')}</button>}
                <button aria-label={t('Delete digest')} className="hover:text-danger" onClick={() => void api.digest.remove(e.id).then(refresh).catch(toastError)}><Trash2 size={14} /></button>
              </span>
            </div>
            <ul>
              {e.items.map((it) => { const l = label(it); return (
                <li key={it.channelId}>
                  <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-hover" onClick={() => { void api.digest.markRead(e.id).then(refresh).catch(() => {}); close(); goto(it.guildId, it.channelId); }}>
                    <span className="min-w-0 flex-1 truncate"><b className="text-header">{l.name}</b> <span className="text-muted">{l.where}</span></span>
                    <span className="shrink-0 text-sm text-interactive">{t('{n} new', { n: it.count })}{it.mentions > 0 && <b className="ms-2 rounded bg-danger px-1.5 py-0.5 text-[11px] text-white">{t('{n} @', { n: it.mentions })}</b>}</span>
                  </button>
                </li>); })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SavedList({ close }: { close: () => void }) {
  const guilds = useData((s) => s.guilds); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inbox', 'saved'], queryFn: () => api.users.saved({ limit: 100 }) });
  const remove = (m: Message) => api.users.unsave(m.channelId, m.id).then(() => { useSocial.getState().setSaved(m.id, false); void qc.invalidateQueries({ queryKey: ['inbox', 'saved'] }); }).catch(toastError);
  return (
    <div>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {!q.isLoading && !q.data?.length && <Empty icon={<Bookmark size={40} />} title={t('Nothing saved yet')}>{t('Use “Save for Later” in a message menu to keep it here.')}</Empty>}
      <ul aria-label={t('Saved messages')}>
        {q.data?.map((m) => (
          <li key={m.id} className="group relative" data-inbox-item={m.id}>
            <div className="mb-1 ps-1 text-xs font-semibold text-muted">{m.guildId ? guilds[m.guildId]?.guild.name ?? '' : t('Direct Message')}</div>
            <ResultCard m={m} onOpen={close} channel={m.guildId ? guilds[m.guildId]?.channels[m.channelId] : undefined} />
            <button aria-label={t('Remove from Saved')} title={t('Remove from Saved')} onClick={() => remove(m)} className="absolute end-2 top-6 hidden h-7 w-7 items-center justify-center rounded-full bg-[rgb(var(--rail))] text-muted hover:text-danger group-hover:flex focus:flex"><Trash2 size={14} /></button>
          </li>))}
      </ul>
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
function RemindersList({ close }: { close: () => void }) {
  const guilds = useData((s) => s.guilds); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inbox', 'reminders'], queryFn: api.users.reminders });
  const del = (id: string) => api.users.deleteReminder(id).then(() => qc.invalidateQueries({ queryKey: ['inbox', 'reminders'] })).catch(toastError);
  const due = q.data?.filter((r) => r.firedAt) ?? [], pending = q.data?.filter((r) => !r.firedAt) ?? [];
  const Row = ({ r }: { r: NonNullable<typeof q.data>[number] }) => (
    <li className="group relative" data-reminder={r.id} data-due={r.firedAt ? 'true' : 'false'}>
      <div className="mb-1 flex items-center gap-1 ps-1 text-xs font-semibold text-muted"><AlarmClock size={12} />{r.firedAt ? t('Due') : t('Reminds you')} {when(r.remindAt)}</div>
      <ResultCard m={r.message} onOpen={close} channel={r.message.guildId ? guilds[r.message.guildId]?.channels[r.message.channelId] : undefined} />
      <button aria-label={r.firedAt ? t('Dismiss reminder') : t('Cancel reminder')} title={r.firedAt ? t('Dismiss reminder') : t('Cancel reminder')} onClick={() => void del(r.id)} className="absolute end-2 top-6 hidden h-7 w-7 items-center justify-center rounded-full bg-[rgb(var(--rail))] text-muted hover:text-danger group-hover:flex focus:flex"><Trash2 size={14} /></button>
    </li>
  );
  return (
    <div>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {!q.isLoading && !q.data?.length && <Empty icon={<AlarmClock size={40} />} title={t('No reminders')}>{t('Use “Remind Me” in a message menu and it will come back to you here.')}</Empty>}
      {due.length > 0 && <><h3 className="section-title px-1 pb-2">{t('Due')}</h3><ul aria-label={t('Due reminders')}>{due.map((r) => <Row key={r.id} r={r} />)}</ul></>}
      {pending.length > 0 && <><h3 className="section-title px-1 pb-2 pt-3">{t('Upcoming')}</h3><ul aria-label={t('Upcoming reminders')}>{pending.map((r) => <Row key={r.id} r={r} />)}</ul></>}
    </div>
  );
}

function ScheduledList() {
  const openModal = useUI((s) => s.openModal);
  const guilds = useData((s) => s.guilds); const dms = useData((s) => s.dms); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inbox', 'scheduled'], queryFn: api.messages.scheduled });
  const cancel = (id: string) => api.messages.cancelScheduled(id).then(() => qc.invalidateQueries({ queryKey: ['inbox', 'scheduled'] })).catch(toastError);
  const where = (s: ScheduledMessage) => { const ch = s.guildId ? guilds[s.guildId]?.channels[s.channelId] : undefined; return s.guildId ? `#${ch?.name ?? 'channel'}` : dms[s.channelId]?.recipients?.map((u) => u.displayName || u.username).join(', ') || t('Direct message'); };
  return (
    <div>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {!q.isLoading && !q.data?.length && <Empty icon={<CalendarClock size={40} />} title={t('Nothing scheduled')}>{t('Write a message, then use the clock button next to the emoji picker to send it later.')}</Empty>}
      <ul aria-label={t('Scheduled messages')} className="flex flex-col gap-2">
        {q.data?.map((s) => (
          <li key={s.id} data-scheduled={s.id} data-status={s.status} className="group relative rounded-lg border border-divider bg-side p-3">
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted"><CalendarClock size={12} />{s.status === 'pending' || s.status === 'sending' ? t('Sends') : s.status === 'sent' ? t('Sent') : s.status === 'failed' ? t('Failed') : t('Canceled')} {when(s.sendAt)} · {where(s)}</div>
            {s.content && <div className="whitespace-pre-wrap break-words text-sm text-normal">{s.content}</div>}
            {s.attachments?.length > 0 && <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted">{s.attachments.map((a) => <span key={a.id} className="inline-flex items-center gap-1"><Paperclip size={12} />{a.filename}</span>)}</div>}
            {s.error && <div className="mt-1 text-xs text-danger" role="alert">{s.error}</div>}
            {s.status === 'pending' && <button aria-label={t('Edit scheduled message')} title={t('Edit scheduled message')} data-testid="scheduled-edit" onClick={() => openModal({ kind: 'scheduleMessage', channelId: s.channelId, content: s.content, edit: s })} className="absolute end-11 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-[rgb(var(--rail))] text-muted hover:text-normal"><Pencil size={14} /></button>}
            <button aria-label={s.status === 'pending' ? t('Cancel scheduled message') : t('Remove from list')} title={s.status === 'pending' ? t('Cancel scheduled message') : t('Remove from list')} disabled={s.status === 'sending'} onClick={() => void cancel(s.id)} className="absolute end-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-[rgb(var(--rail))] text-muted hover:text-danger disabled:opacity-40"><Trash2 size={14} /></button>
          </li>))}
      </ul>
    </div>
  );
}

export function InboxModal({ initialTab, close }: { initialTab?: InboxTab; close: () => void }) {
  const [tab, setTab] = useState<InboxTab>(initialTab ?? 'mentions');
  const digestUnread = useQuery({ queryKey: ['inbox', 'digest'], queryFn: () => api.digest.list({ limit: 25 }), retry: false }).data?.filter((e) => !e.readAt).length ?? 0;
  const due = useQuery({ queryKey: ['inbox', 'reminders'], queryFn: api.users.reminders }).data?.filter((r) => r.firedAt).length ?? 0;
  return (
    <Modal title={t('Inbox')} onClose={close} width={560}>
      <div className="mb-3"><Tabs label={t('Inbox')} value={tab} onChange={setTab} tabs={[{ id: 'mentions', label: t('Mentions') }, { id: 'digest', label: t('Digest'), badge: digestUnread }, { id: 'saved', label: t('Saved') }, { id: 'reminders', label: t('Reminders'), badge: due }, { id: 'scheduled', label: t('Scheduled') }]} /></div>
      <div className="max-h-[60dvh] overflow-y-auto" data-testid="inbox">{tab === 'mentions' && <MentionsList close={close} />}{tab === 'digest' && <DigestList close={close} />}{tab === 'saved' && <SavedList close={close} />}{tab === 'reminders' && <RemindersList close={close} />}{tab === 'scheduled' && <ScheduledList />}</div>
    </Modal>
  );
}

interface Dest { id: string; label: string; sub: string; dm?: boolean; avatar?: import('@jorcord/shared').User }
const MAX_FORWARD_TARGETS = 5;

/** Pick up to five channels / DMs to forward a message to. */
const REPORT_REASONS = ['spam', 'harassment', 'inappropriate_content', 'impersonation', 'security', 'other'];

export function ReportModal({ messageId, guildId, channelId, close }: { messageId: string; guildId: string; channelId: string; close: () => void }) {
  const [reason, setReason] = useState(REPORT_REASONS[0]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = () => {
    setBusy(true);
    api.messages.report(channelId, messageId, { reason, description: description.trim() || undefined }).then(() => { toast(t('Message reported'), 'success'); close(); }).catch(toastError).finally(() => setBusy(false));
  };
  return (
    <Modal title={t('Report Message')} onClose={close} width={420}
      footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-danger" disabled={!reason || busy} onClick={() => void submit()}>{t('Report')}</button></>}>
      <p className="mb-3 text-sm text-muted">{t('What best describes this message?')}</p>
      <fieldset className="space-y-1">
        {REPORT_REASONS.map((r) => (
          <label key={r} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 ${reason === r ? 'border-brand bg-brand/10' : 'border-transparent hover:bg-hover'}`}>
            <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} className="h-4 w-4 accent-brand" />
            <span className="text-sm">{t(r)}</span>
          </label>))}
      </fieldset>
      <label className="mt-3 block">
        <span className="text-sm text-muted">{t('Additional details (optional)')}</span>
        <textarea
          className="field mt-1"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('Anything else moderators should know?')}
        />
      </label>
      <p className="mt-3 text-xs text-muted">{t('Your report will be reviewed by the server moderators.')}</p>
    </Modal>
  );
}

/** Maps a report reason enum to a short label + severity class. */
const REASON_LABEL = { spam: 'Spam', harassment: 'Harassment', inappropriate_content: 'Inappropriate', impersonation: 'Impersonation', security: 'Security', other: 'Other' } as const;
function reasonLabel(r: ReportReason) {
  const label = REASON_LABEL[r];
  const cls = (r === 'spam' || r === 'inappropriate_content') ? 'bg-warn/20 text-warn' : r === 'harassment' ? 'bg-danger/20 text-danger' : 'bg-side text-muted';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>
  );
}

/** Moderator queue: list open/resolved/dismissed reports for a guild and triage them. */
export function ReportQueueModal({ guildId, close }: { guildId: Id; close: () => void }) {
  const qc = useQueryClient(); const users = useData((s) => s.users); const guilds = useData((s) => s.guilds); const me = useData((s) => s.me);
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed' | 'all'>('open');
  const q = useQuery({ queryKey: ['reports', guildId, status], queryFn: () => api.guilds.reports(guildId, { status }), retry: false });
  const triage = (rid: Id, to: 'resolved' | 'dismissed') => {
    const fn = to === 'resolved' ? api.guilds.resolveReport : api.guilds.dismissReport;
    return fn(guildId, rid).then((r) => { void qc.invalidateQueries({ queryKey: ['reports', guildId] }); toast(t(`Report ${to}`), 'success'); }).catch(toastError);
  };
  const g = guilds[guildId]?.guild;
  const channelName = (cid: Id) => guilds[guildId]?.channels[cid]?.name ?? cid;
  const reporter = (id: Id) => users[id] ?? { id, username: id, discriminator: '0', avatar: null };
  const target = (id: Id) => users[id] ?? { id, username: id, discriminator: '0', avatar: null };
  const timeAgo = (iso: string) => {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return t('Just now');
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };
  const tabs = [
    { id: 'open' as const, label: t('Open') },
    { id: 'resolved' as const, label: t('Resolved') },
    { id: 'dismissed' as const, label: t('Dismissed') },
    { id: 'all' as const, label: t('All') },
  ];
  const rows = q.data ?? [];
  const row = (r: typeof rows[number]) => {
    const snap = r.message;
    const attachBlock = snap && snap.attachments.length > 0 ? (
      <div className="mt-1 flex flex-wrap gap-1">{snap.attachments.map((a) => <span key={a.url} className="text-xs text-muted">{a.filename}</span>)}</div>
    ) : null;
    return (
      <li key={r.id} className="rounded-lg border border-divider bg-rail mb-2 p-3 last:border-b last:border-b-0" data-report={r.id}>
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0 flex items-center gap-2">
            <Avatar user={target(r.targetUserId)} size={28} />
            <div className="min-w-0">
              <div className="truncate font-semibold text-header">{target(r.targetUserId).username}</div>
              <div className="text-xs text-muted">{channelName(r.channelId)} • {t('by')} {reporter(r.reporterId).username}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">{reasonLabel(r.reason)}{r.status !== 'open' ? <span className="text-xs text-muted">{timeAgo(r.createdAt)}</span> : null}</div> /* reason */
        </div>
        {r.description ? <p className="mb-2 text-sm text-muted">{r.description}</p> : null}
        {snap && (snap.content || snap.attachments.length) ? (
          <div className="mb-2 rounded bg-side/60 border border-divider/60 p-2 text-sm">
            <div className="text-xs font-semibold text-muted">{t('Reported message')}</div>
            <p className="mt-0.5 text-header break-words">{snap.content || t('(attachment)')}</p>
            {attachBlock}
          </div>
        ) : null}
        {r.status === 'open' ? (
          <div className="flex items-center gap-2 mt-1">
            <button className="btn btn-sm btn-primary" disabled={!me || r.handledBy === me?.id} onClick={() => void triage(r.id, 'resolved')} type="button">{t('Resolve')}</button>
            <button className="btn btn-sm btn-secondary" disabled={!me || r.handledBy === me?.id} onClick={() => void triage(r.id, 'dismissed')} type="button">{t('Dismiss')}</button>
            {r.handledBy && (<span className="ml-auto text-xs text-muted">{t('Handled by')} {users[r.handledBy]?.username ?? r.handledBy}</span>)}
          </div>
        ) : null}
      </li>
    );
  };
  return (
    <Modal title={`${t('Reports')} ${g ? `• ${g.name}` : ''}`} onClose={close} width={680}>
      <div className="mb-4 flex items-center gap-3">
        <div className="flex rounded-lg border border-divider bg-rail p-0.5" role="tablist">{tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={status === t.id} onClick={() => setStatus(t.id)} className={`rounded-lg px-3 py-1 text-sm font-medium ${status === t.id ? 'bg-active text-header shadow' : 'text-muted hover:text-header'}`}>{t.label}</button>))}
        </div>
        <span className="text-xs text-muted">{rows.length} {t('reports')}</span>
      </div>
      {q.isLoading ? <Spinner className="mx-auto my-8" /> : rows.length === 0 ? <p className="py-8 text-center text-sm text-muted">{t('No reports here.')}</p> : (
        <ul aria-label={t('Reports')}>{rows.map(row)}</ul>)}
      <div className="mt-3 flex justify-end"><button className="btn btn-secondary" onClick={close}>{t('Close')}</button></div>
    </Modal>);
}

export function ForwardModal({ message, close }: { message: Message; close: () => void }) {
  const dms = useData((s) => s.dms); const guilds = useData((s) => s.guilds); const me = useData((s) => s.me);
  const [q, setQ] = useState(''); const [picked, setPicked] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  const dests = useMemo<Dest[]>(() => {
    const out: Dest[] = [];
    for (const c of Object.values(dms)) out.push({ id: c.id, label: dmName(c, me?.id), sub: c.type === 'group_dm' ? t('Group DM') : t('Direct Message'), dm: true, avatar: c.type === 'dm' ? c.recipients?.[0] : undefined });
    for (const g of Object.values(guilds)) for (const c of Object.values(g.channels)) {
      if (c.type !== 'text' && c.type !== 'announcement') continue;
      if (!(myChannelPerms(c.id) & Perm.SEND_MESSAGES)) continue;
      out.push({ id: c.id, label: c.name ?? '', sub: g.guild.name });
    }
    return out;
  }, [dms, guilds, me?.id]);
  const shown = dests.filter((d) => !q || d.label.toLowerCase().includes(q.toLowerCase()) || d.sub.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_FORWARD_TARGETS ? p : [...p, id]));
  const submit = async () => {
    setBusy(true); let ok = 0;
    for (const id of picked) {
      try { await api.messages.forward(id, { channelId: message.channelId, messageId: message.id }); ok++; } catch (e) { toastError(e); }
    }
    setBusy(false);
    if (ok) { toast(ok === 1 ? t('Message forwarded') : t('Message forwarded to {n} places', { n: ok }), 'success'); close(); }
  };
  return (
    <Modal title={t('Forward Message')} onClose={close} width={460}
      footer={<><span className="me-auto text-sm text-muted">{picked.length}/{MAX_FORWARD_TARGETS}</span><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary" disabled={!picked.length || busy} onClick={() => void submit()}>{t('Send')}</button></>}>
      <input autoFocus className="field mb-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search channels and people')} aria-label={t('Search channels and people')} />
      <div className="mb-3 line-clamp-3 rounded border-s-4 border-brand bg-side p-2 text-sm text-muted">{message.content || (message.attachments[0]?.filename ?? message.forward?.content ?? '')}</div>
      <ul className="max-h-[40dvh] overflow-y-auto" aria-label={t('Destinations')}>
        {shown.map((d) => (
          <li key={d.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-hover">
              <input type="checkbox" checked={picked.includes(d.id)} disabled={!picked.includes(d.id) && picked.length >= MAX_FORWARD_TARGETS} onChange={() => toggle(d.id)} aria-label={`${d.label} ${d.sub}`} />
              {d.dm ? (d.avatar ? <Avatar user={d.avatar} size={24} /> : <Users size={20} className="text-muted" />) : <Hash size={20} className="text-muted" />}
              <span className="min-w-0 flex-1 truncate font-medium text-header">{d.label}</span><span className="truncate text-xs text-muted">{d.sub}</span>
            </label>
          </li>))}
        {!shown.length && <li className="py-6 text-center text-sm text-muted">{t('No matches')}</li>}
      </ul>
    </Modal>
  );
}
