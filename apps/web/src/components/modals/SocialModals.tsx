/** Social-layer modals: Inbox (mentions), later saved items and reminders. */
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AtSign } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
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
