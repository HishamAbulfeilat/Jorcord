/** Social-layer modals: Inbox (mentions), later saved items and reminders. */
import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AtSign, Hash, Users } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { Perm } from '@jorcord/shared';
import { myChannelPerms } from '@/lib/session';
import { Avatar } from '@/components/ui/Avatar';
import { dmName } from '@/lib/format';
import { Modal, Tabs, Spinner, Empty } from '@/components/ui/primitives';
import { ResultCard } from '@/components/chat/Panels';
import { t } from '@/i18n';

type InboxTab = 'mentions';

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

export function InboxModal({ close }: { initialTab?: string; close: () => void }) {
  const [tab, setTab] = useState<InboxTab>('mentions');
  return (
    <Modal title={t('Inbox')} onClose={close} width={560}>
      <div className="mb-3"><Tabs label={t('Inbox')} value={tab} onChange={setTab} tabs={[{ id: 'mentions', label: t('Mentions') }]} /></div>
      <div className="max-h-[60dvh] overflow-y-auto" data-testid="inbox">{tab === 'mentions' && <MentionsList close={close} />}</div>
    </Modal>
  );
}

interface Dest { id: string; label: string; sub: string; dm?: boolean; avatar?: import('@jorcord/shared').User }
const MAX_FORWARD_TARGETS = 5;

/** Pick up to five channels / DMs to forward a message to. */
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
