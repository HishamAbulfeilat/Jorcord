import { useMemo, useState } from 'react';
import { Lock, MessagesSquare, Plus } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useNav } from '@/lib/nav';
import { useGuildPerms } from '@/lib/useGuild';
import { can } from '@/lib/perms';
import { ChannelHeader } from './ChatView';
import { Empty } from '@/components/ui/primitives';
import { Avatar } from '@/components/ui/Avatar';
import { compareId, displayName, fmtStamp, msgTime } from '@/lib/format';
import { snowflakeTime } from '@jorcord/shared';
import { t } from '@/i18n';
import { cx } from '@/lib/format';

export function ForumView({ channel }: { channel: Channel }) {
  const nav = useNav(); const open = useUI((s) => s.openModal);
  const perms = useGuildPerms(channel.guildId ?? undefined, channel);
  const chans = useData((s) => s.guilds[channel.guildId!]?.channels);
  const posts = useMemo(() => Object.values(chans ?? {}).filter((c) => c.type === 'thread' && c.parentId === channel.id).sort((a, b) => compareId(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id)), [chans, channel.id]);
  const users = useData((s) => s.users);
  const tags = channel.availableTags ?? []; const [filter, setFilter] = useState<string | null>(null);
  const shown = filter ? posts.filter((p) => p.appliedTags?.includes(filter)) : posts;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-chat">
      <ChannelHeader channel={channel} />
      <div className="scroller min-h-0 flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div><h2 className="text-xl font-bold text-header">{t('Posts')}</h2><p className="text-sm text-muted">{channel.topic || 'Start a conversation about a topic. Every post is its own thread.'}</p></div>
            <button className="btn btn-primary shrink-0" disabled={!can(perms, Perm.CREATE_PUBLIC_THREADS) && !can(perms, Perm.SEND_MESSAGES)} onClick={() => open({ kind: 'createForumPost', channelId: channel.id })}><Plus size={16} />{t('New Post')}</button>
          </div>
          {tags.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Filter by tag')}>
              <button aria-pressed={filter === null} onClick={() => setFilter(null)} className={cx('rounded-full border px-2.5 py-0.5 text-sm font-medium', filter === null ? 'border-brand bg-brand/20 text-header' : 'border-divider text-interactive hover:bg-hover')}>{t('All')}</button>
              {tags.map((tg) => <button key={tg.id} aria-pressed={filter === tg.id} onClick={() => setFilter(filter === tg.id ? null : tg.id)} className={cx('rounded-full border px-2.5 py-0.5 text-sm font-medium', filter === tg.id ? 'border-brand bg-brand/20 text-header' : 'border-divider text-interactive hover:bg-hover')}>{tg.emoji} {tg.name}</button>)}
            </div>)}
          {!shown.length && <Empty icon={<MessagesSquare size={44} />} title={filter ? t('No posts with this tag') : t('No posts yet')}>{t('Be the first to start a discussion.')}</Empty>}
          <ul className="grid gap-3 sm:grid-cols-2">
            {shown.map((p) => {
              const owner = p.ownerId ? users[p.ownerId] : undefined;
              return (
                <li key={p.id}><button onClick={() => nav.go(channel.guildId, p.id)} className="flex h-full w-full flex-col gap-2 rounded-lg border border-divider bg-side p-4 text-start transition-colors hover:border-brand/60 hover:bg-hover">
                  <span className="line-clamp-2 text-base font-bold text-header">{p.locked && <Lock size={14} className="me-1 inline text-muted" aria-label={t('Locked')} />}{p.name}</span>
                  {!!p.appliedTags?.length && <span className="flex flex-wrap gap-1" data-testid="post-tags">{p.appliedTags.map((id) => tags.find((x) => x.id === id)).filter(Boolean).map((tg) => <span key={tg!.id} className="rounded-full bg-active px-2 py-px text-xs font-medium text-header">{tg!.emoji} {tg!.name}</span>)}</span>}
                  <span className="mt-auto flex items-center gap-2 text-xs text-muted">{owner && <Avatar user={owner} size={20} />}<span>{owner ? displayName(owner) : 'Unknown'}</span><span>•</span><span>{fmtStamp(p.createdAt ? new Date(p.createdAt).getTime() : snowflakeTime(p.id))}</span>{p.archived && <span className="rounded bg-active px-1">{t('Archived')}</span>}</span>
                </button></li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
void msgTime;
