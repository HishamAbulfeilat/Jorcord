import { MessagesSquare, Plus } from 'lucide-react';
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

export function ForumView({ channel }: { channel: Channel }) {
  const nav = useNav(); const open = useUI((s) => s.openModal);
  const perms = useGuildPerms(channel.guildId ?? undefined, channel);
  const posts = useData((s) => Object.values(s.guilds[channel.guildId!]?.channels ?? {}).filter((c) => c.type === 'thread' && c.parentId === channel.id).sort((a, b) => compareId(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id)));
  const users = useData((s) => s.users);
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-chat">
      <ChannelHeader channel={channel} />
      <div className="scroller min-h-0 flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div><h2 className="text-xl font-bold text-header">Posts</h2><p className="text-sm text-muted">{channel.topic || 'Start a conversation about a topic. Every post is its own thread.'}</p></div>
            <button className="btn btn-primary shrink-0" disabled={!can(perms, Perm.CREATE_PUBLIC_THREADS) && !can(perms, Perm.SEND_MESSAGES)} onClick={() => open({ kind: 'createForumPost', channelId: channel.id })}><Plus size={16} />New Post</button>
          </div>
          {!posts.length && <Empty icon={<MessagesSquare size={44} />} title="No posts yet">Be the first to start a discussion.</Empty>}
          <ul className="grid gap-3 sm:grid-cols-2">
            {posts.map((p) => {
              const owner = p.ownerId ? users[p.ownerId] : undefined;
              return (
                <li key={p.id}><button onClick={() => nav.go(channel.guildId, p.id)} className="flex h-full w-full flex-col gap-2 rounded-lg border border-divider bg-side p-4 text-left transition-colors hover:border-brand/60 hover:bg-hover">
                  <span className="line-clamp-2 text-base font-bold text-header">{p.name}</span>
                  <span className="mt-auto flex items-center gap-2 text-xs text-muted">{owner && <Avatar user={owner} size={20} />}<span>{owner ? displayName(owner) : 'Unknown'}</span><span>•</span><span>{fmtStamp(snowflakeTime(p.id))}</span>{p.archived && <span className="rounded bg-active px-1">Archived</span>}</span>
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
