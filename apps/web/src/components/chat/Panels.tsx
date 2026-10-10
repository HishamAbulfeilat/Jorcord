import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X, Pin, PinOff, MessagesSquare, Hash, CornerDownRight } from 'lucide-react';
import { canPinMessage } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { toastError } from '@/stores/ui';
import { t } from '@/i18n';
import type { Channel, Message } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useNav } from '@/lib/nav';
import { Avatar } from '@/components/ui/Avatar';
import { Spinner, Empty } from '@/components/ui/primitives';
import { Markdown } from './Markdown';
import { displayName, fmtStamp, msgTime, cx } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { AttachmentView } from './Attachments';

function PanelShell({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <aside aria-label={title} className="flex h-full w-full flex-col bg-side md:w-[420px]">
      <div className="flex h-12 shrink-0 items-center justify-between px-4 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content"><h2 className="font-bold text-header">{title}</h2><div className="flex items-center gap-2">{actions}<button aria-label={`Close ${title}`} onClick={onClose} className="touch flex h-8 w-8 items-center justify-center text-interactive hover:text-header"><X size={20} /></button></div></div>
      <div className="scroller min-h-0 flex-1 p-2">{children}</div>
    </aside>
  );
}

function ResultCard({ m, channel }: { m: Message; channel?: Channel }) {
  const nav = useNav(); const u = useData((s) => s.users[m.author.id]) ?? m.author;
  const member = useData((s) => (m.guildId ? s.guilds[m.guildId]?.members[m.author.id] : undefined));
  const go = () => { nav.go(m.guildId, m.channelId); setTimeout(() => window.dispatchEvent(new CustomEvent('jorcord:jump', { detail: { channelId: m.channelId, messageId: m.id } })), 400); };
  return (
    <button onClick={go} className="mb-2 block w-full rounded-md border border-divider bg-chat p-3 text-start hover:bg-chat-hover">
      {channel && <div className="mb-1 flex items-center gap-1 text-xs text-muted"><Hash size={12} />{channel.name}</div>}
      <div className="flex items-center gap-2"><Avatar user={u} size={24} /><span className="font-medium text-header">{displayName(u, member)}</span><time className="text-xs text-muted">{fmtStamp(msgTime(m.id, m.createdAt))}</time></div>
      <div className="mt-1 ps-8 text-sm"><Markdown content={m.content} guildId={m.guildId} />{m.attachments.slice(0, 1).map((a) => <div key={a.id} className="mt-1"><AttachmentView a={a} /></div>)}</div>
    </button>
  );
}

export function SearchPanel({ guildId, channel, onClose }: { guildId: string | undefined; channel: Channel; onClose: () => void }) {
  const q = useUI((s) => s.searchQuery); const setQ = useUI((s) => s.setSearchQuery);
  const [has, setHas] = useState(''); const [scope, setScope] = useState<'server' | 'channel'>('server');
  const dq = useDebounced(q, 350);
  const chans = useData((s) => (guildId ? s.guilds[guildId]?.channels : undefined));
  const res = useQuery({
    queryKey: ['search', guildId ?? channel.id, scope, dq, has], enabled: dq.trim().length > 1 || !!has,
    queryFn: () => (guildId ? api.guilds.search(guildId, { q: dq, has: has || undefined, channelId: scope === 'channel' ? channel.id : undefined }) : api.guilds.search('@me', { q: dq, channelId: channel.id })),
  });
  return (
    <PanelShell title={t('Search Results')} onClose={onClose}>
      <div className="mb-2 flex items-center rounded bg-rail px-2"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search messages" placeholder="Search" className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {guildId && (['server', 'channel'] as const).map((s) => <button key={s} aria-pressed={scope === s} onClick={() => setScope(s)} className={cx('rounded-full px-3 py-1 text-xs font-semibold', scope === s ? 'bg-brand text-white' : 'bg-active text-interactive')}>{s === 'server' ? 'Everywhere' : 'This channel'}</button>)}
        {['image', 'file', 'link', 'embed'].map((h) => <button key={h} aria-pressed={has === h} onClick={() => setHas(has === h ? '' : h)} className={cx('rounded-full px-3 py-1 text-xs font-semibold', has === h ? 'bg-brand text-white' : 'bg-active text-interactive')}>has: {h}</button>)}
      </div>
      {res.isFetching && <Spinner className="mx-auto my-6" />}
      {!res.isFetching && res.data?.length === 0 && <Empty icon={<Search size={40} />} title="No results found">Try different keywords or filters.</Empty>}
      {!res.isFetching && !res.data && <Empty icon={<Search size={40} />} title="Search messages">Type at least two characters.</Empty>}
      {res.data?.map((m) => <ResultCard key={m.id} m={m} channel={chans?.[m.channelId]} />)}
    </PanelShell>
  );
}

export function PinsPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const q = useQuery({ queryKey: ['pins', channel.id], queryFn: () => api.messages.pins(channel.id) });
  const canPin = canPinMessage(myChannelPerms(channel.id), !channel.guildId);
  useEffect(() => { const h = (e: Event) => { if ((e as CustomEvent).detail === channel.id) q.refetch(); }; window.addEventListener('jorcord:pins', h); return () => window.removeEventListener('jorcord:pins', h); }, [channel.id]); // eslint-disable-line
  return (
    <PanelShell title={t('Pinned Messages')} onClose={onClose}>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {q.data?.length === 0 && <Empty icon={<Pin size={40} />} title="No pinned messages yet">Pin important messages to keep them handy for everyone.</Empty>}
      {q.data?.map((m) => (
        <div key={m.id} className="group relative" data-pinned={m.id}>
          <ResultCard m={m} />
          {canPin && <button aria-label={t('Unpin')} title={t('Unpin')} onClick={() => api.messages.unpin(channel.id, m.id).then(() => q.refetch()).catch(toastError)} className="absolute end-2 top-2 hidden h-7 w-7 items-center justify-center rounded-full bg-[rgb(var(--active))] text-interactive hover:text-danger group-hover:flex focus:flex"><PinOff size={14} /></button>}
        </div>))}
    </PanelShell>
  );
}

export function ThreadsPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const nav = useNav();
  const chans = useData((s) => (channel.guildId ? s.guilds[channel.guildId]?.channels : undefined));
  const threads = useMemo(() => Object.values(chans ?? {}).filter((c) => c.type === 'thread' && c.parentId === channel.id), [chans, channel.id]);
  useQuery({ queryKey: ['threads', channel.id], queryFn: async () => { const [a, b] = await Promise.all([api.channels.threads(channel.id, false), api.channels.threads(channel.id, true)]); [...a, ...b].forEach((t) => useData.getState().apply('THREAD_UPDATE', t)); return true; }, staleTime: 15_000 });
  const active = threads.filter((t) => !t.archived), old = threads.filter((t) => t.archived);
  const Row = ({ t }: { t: Channel }) => <button onClick={() => { nav.go(channel.guildId, t.id); onClose(); }} className="mb-2 flex w-full items-center gap-3 rounded-md border border-divider bg-chat p-3 text-start hover:bg-chat-hover"><MessagesSquare size={20} className="text-muted" /><span className="min-w-0 flex-1"><span className="block truncate font-semibold text-header">{t.name}</span><span className="text-xs text-muted">{t.archived ? 'Archived' : 'Active'}</span></span><CornerDownRight size={16} className="text-muted" /></button>;
  return (
    <PanelShell title={t('Threads')} onClose={onClose}>
      {!threads.length && <Empty icon={<MessagesSquare size={40} />} title="There are no threads">Stay focused on a conversation with a thread. Hover a message and use “Create Thread”.</Empty>}
      {active.length > 0 && <h3 className="section-title px-1 pb-2">Active threads</h3>}{active.map((t) => <Row key={t.id} t={t} />)}
      {old.length > 0 && <h3 className="section-title px-1 pb-2 pt-3">Archived</h3>}{old.map((t) => <Row key={t.id} t={t} />)}
    </PanelShell>
  );
}
