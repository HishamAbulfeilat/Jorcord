import { useData } from '@/stores/data';
import { useNow } from '@/lib/hooks';
import { displayName } from '@/lib/format';
import { useShallow } from 'zustand/react/shallow';

export function TypingIndicator({ channelId, guildId }: { channelId: string; guildId?: string | null }) {
  const now = useNow(1000);
  const names = useData(useShallow((s) => Object.entries(s.typing[channelId] ?? {}).filter(([id, ts]) => now - ts < 9000 && s.relationships[id]?.type !== 'blocked').map(([id]) => displayName(s.users[id] ?? { username: 'Someone', displayName: null }, guildId ? s.guilds[guildId]?.members[id] : undefined))));
  const text = names.length === 0 ? '' : names.length === 1 ? <><b>{names[0]}</b> is typing…</> : names.length === 2 ? <><b>{names[0]}</b> and <b>{names[1]}</b> are typing…</> : names.length === 3 ? <><b>{names[0]}</b>, <b>{names[1]}</b> and <b>{names[2]}</b> are typing…</> : 'Several people are typing…';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-6 items-center gap-1.5 px-4 text-[13px] text-header" role="status" aria-live="polite" aria-atomic="true">
      {names.length > 0 && (<>
        <span className="flex gap-0.5" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-header" style={{ animationDelay: `${i * 0.15}s` }} />)}</span>
        <span className="truncate">{text}</span>
      </>)}
    </div>
  );
}
