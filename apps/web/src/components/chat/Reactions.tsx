import { SmilePlus } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useMessages } from '@/stores/messages';
import { useData } from '@/stores/data';
import { useUI, toastError } from '@/stores/ui';
import { cx } from '@/lib/format';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';

export function ReactionBar({ m }: { m: Message }) {
  const me = useData((s) => s.me); const store = useMessages.getState; const openPopout = useUI((s) => s.openPopout); const openModal = useUI((s) => s.openModal);
  const emojis = useData((s) => (m.guildId ? s.guilds[m.guildId]?.emojis : undefined));
  if (!m.reactions.length || !me) return null;
  const canReact = !m.guildId || can(myChannelPerms(m.channelId), Perm.ADD_REACTIONS);
  const toggle = (r: Message['reactions'][number]) => {
    if (!canReact && !r.me) return;
    const was = r.me; store().reaction(m.channelId, m.id, r.emoji, r.emojiId, was ? -1 : 1, true);
    (was ? api.messages.unreact : api.messages.react)(m.channelId, m.id, r.emoji, r.emojiId).catch((e) => { store().reaction(m.channelId, m.id, r.emoji, r.emojiId, was ? 1 : -1, true); toastError(e); });
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Reactions">
      {m.reactions.map((r) => {
        const custom = r.emojiId ? emojis?.find((e) => e.id === r.emojiId)?.url ?? `/api/v1/emojis/${r.emojiId}.webp` : null;
        return (
          <button key={`${r.emoji}:${r.emojiId}`} aria-pressed={r.me} aria-label={`${r.emoji} ${r.count}`} onClick={() => toggle(r)}
            onContextMenu={(e) => { e.preventDefault(); openModal({ kind: 'reactors', channelId: m.channelId, messageId: m.id, emoji: r.emoji, emojiId: r.emojiId }); }}
            className={cx('flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-sm md:h-6', r.me ? 'border-brand bg-brand/20 text-[rgb(var(--mention))]' : 'border-transparent bg-[rgb(var(--active)/0.6)] text-interactive hover:border-[rgb(var(--interactive)/0.5)]')}>
            {custom ? <img src={custom} alt={r.emoji} className="h-4 w-4" /> : <span className="text-base leading-none">{r.emoji}</span>}
            <span className="text-xs font-semibold">{r.count}</span>
          </button>
        );
      })}
      {canReact && <button aria-label="Add reaction" onClick={(e) => openPopout({ kind: 'emoji', rect: e.currentTarget.getBoundingClientRect(), guildId: m.guildId ?? undefined, onPick: (p) => addReaction(m, p) })} className="flex h-6 w-8 items-center justify-center rounded-md bg-[rgb(var(--active)/0.6)] text-interactive hover:text-header"><SmilePlus size={16} /></button>}
    </div>
  );
}

export function addReaction(m: Message, p: { char?: string; name: string; id?: string }) {
  const emoji = p.char ?? p.name; const emojiId = p.id ?? null;
  const existing = m.reactions.find((r) => r.emoji === emoji && r.emojiId === emojiId);
  if (existing?.me) return;
  useMessages.getState().reaction(m.channelId, m.id, emoji, emojiId, 1, true);
  api.messages.react(m.channelId, m.id, emoji, emojiId).catch((e) => { useMessages.getState().reaction(m.channelId, m.id, emoji, emojiId, -1, true); toastError(e); });
}
