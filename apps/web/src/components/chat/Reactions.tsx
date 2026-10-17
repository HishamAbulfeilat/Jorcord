import { Fragment } from 'react';
import { apiBase } from '@/lib/server';
import { SmilePlus } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useMessages } from '@/stores/messages';
import { useData } from '@/stores/data';
import { useUI, toastError } from '@/stores/ui';
import { cx, fileUrl } from '@/lib/format';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { t } from '@/i18n';

export function ReactionBar({ m }: { m: Message }) {
  const me = useData((s) => s.me); const store = useMessages.getState; const openPopout = useUI((s) => s.openPopout); const openModal = useUI((s) => s.openModal);
  const emojis = useData((s) => (m.guildId ? s.guilds[m.guildId]?.emojis : undefined));
  if (!m.reactions.length || !me) return null;
  const canReact = !m.guildId || can(myChannelPerms(m.channelId), Perm.ADD_REACTIONS);
  const toggle = (r: Message['reactions'][number], burst: boolean) => {
    const mine = burst ? !!r.meBurst : r.me;
    if (!canReact && !mine) return;
    store().reaction(m.channelId, m.id, r.emoji, r.emojiId, mine ? -1 : 1, true, burst);
    (mine ? api.messages.unreact : api.messages.react)(m.channelId, m.id, r.emoji, r.emojiId, burst).catch((e) => { store().reaction(m.channelId, m.id, r.emoji, r.emojiId, mine ? 1 : -1, true, burst); toastError(e); });
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t('Reactions')}>
      {m.reactions.map((r) => {
        const custom = r.emojiId ? emojis?.find((e) => e.id === r.emojiId)?.url ? fileUrl(emojis.find((e) => e.id === r.emojiId)!.url) : `${apiBase()}/emojis/${r.emojiId}.webp` : null;
        const emojiEl = custom ? <img loading="lazy" decoding="async" src={custom} alt={r.emoji} className="h-4 w-4" /> : <span className="text-base leading-none">{r.emoji}</span>;
        const burstCount = r.burstCount ?? 0;
        const burstColor = (r.burstColors ?? []).at(-1);
        return (
          <Fragment key={`${r.emoji}:${r.emojiId}`}>
            {r.count > 0 && (
              <button aria-pressed={r.me} aria-label={`${r.emoji} ${r.count}`} onClick={() => toggle(r, false)}
                onContextMenu={(e) => { e.preventDefault(); openModal({ kind: 'reactors', channelId: m.channelId, messageId: m.id, emoji: r.emoji, emojiId: r.emojiId }); }}
                className={cx('flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-sm md:h-6', r.me ? 'border-brand bg-brand/20 text-[rgb(var(--mention))]' : 'border-transparent bg-[rgb(var(--active)/0.6)] text-interactive hover:border-[rgb(var(--interactive)/0.5)]')}>
                {emojiEl}
                <span className="text-xs font-semibold">{r.count}</span>
              </button>
            )}
            {burstCount > 0 && (
              <button aria-pressed={!!r.meBurst} aria-label={`${r.emoji} ${burstCount} ${t('super reaction')}`} onClick={() => toggle(r, true)}
                onContextMenu={(e) => { e.preventDefault(); openModal({ kind: 'reactors', channelId: m.channelId, messageId: m.id, emoji: r.emoji, emojiId: r.emojiId, burst: true }); }}
                style={burstColor ? { borderColor: burstColor, ...(r.meBurst ? { backgroundColor: `${burstColor}40` } : {}) } : undefined}
                className={cx('burst-react flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-sm md:h-6', r.meBurst ? 'text-header' : 'border-transparent bg-[rgb(var(--active)/0.6)] text-interactive hover:border-[rgb(var(--interactive)/0.5)]')}>
                {emojiEl}
                <span className="text-xs font-semibold">{burstCount}</span>
              </button>
            )}
          </Fragment>
        );
      })}
      {canReact && <button aria-label={t('Add reaction')} onClick={(e) => openPopout({ kind: 'emoji', rect: e.currentTarget.getBoundingClientRect(), guildId: m.guildId ?? undefined, allowBurst: true, onPick: (p) => addReaction(m, p) })} className="flex h-6 w-8 items-center justify-center rounded-md bg-[rgb(var(--active)/0.6)] text-interactive hover:text-header"><SmilePlus size={16} /></button>}
    </div>
  );
}

export function addReaction(m: Message, p: { char?: string; name: string; id?: string; burst?: boolean; burstColor?: string }) {
  const emoji = p.char ?? p.name; const emojiId = p.id ?? null; const burst = !!p.burst;
  const existing = m.reactions.find((r) => r.emoji === emoji && r.emojiId === emojiId);
  if (burst ? existing?.meBurst : existing?.me) return;
  useMessages.getState().reaction(m.channelId, m.id, emoji, emojiId, 1, true, burst, p.burstColor ?? null);
  api.messages.react(m.channelId, m.id, emoji, emojiId, burst, p.burstColor).catch((e) => { useMessages.getState().reaction(m.channelId, m.id, emoji, emojiId, -1, true, burst, null); toastError(e); });
}
