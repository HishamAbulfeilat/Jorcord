import { useMemo } from 'react';
import { Compass, Plus } from 'lucide-react';
import { useData, guildUnread, channelUnread } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useNav, useRouteIds } from '@/lib/nav';
import { LogoGlyph } from '@/components/ui/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { Tip } from '@/components/ui/Tooltip';
import { Badge } from '@/components/ui/primitives';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { cx, fileUrl, initials, dmName } from '@/lib/format';
import { guildMenu } from '@/lib/menus';
import { useShallow } from 'zustand/react/shallow';

function GuildButton({ id }: { id: string }) {
  const g = useData((s) => s.guilds[id]?.guild);
  const { unread, mentions } = useData(useShallow((s) => guildUnread(s, id, useUI.getState().prefs.mutedChannels)));
  const muted = useUI((s) => !!s.prefs.mutedGuilds[id]);
  const { guildId } = useRouteIds(); const nav = useNav();
  const last = useUI((s) => s.lastChannel[id]);
  const menu = useMenuTrigger(() => guildMenu(id));
  if (!g) return null;
  const active = guildId === id;
  const icon = fileUrl(g.icon);
  return (
    <div className="relative flex w-full justify-center" {...menu}>
      <span className={cx('absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-header transition-all', active ? 'h-10' : unread && !muted ? 'h-2' : 'h-0')} />
      <Tip text={g.name}>
        <button aria-label={g.name + (mentions ? `, ${mentions} mentions` : unread ? ', unread' : '')} aria-current={active ? 'page' : undefined} onClick={() => nav.go(id, last)}
          className={cx('group relative flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-150 hover:rounded-2xl', active ? 'rounded-2xl bg-brand text-white' : 'rounded-3xl bg-chat text-normal hover:bg-brand hover:text-white', muted && 'opacity-60')}>
          {icon ? <img src={icon} alt="" className="h-full w-full object-cover" draggable={false} /> : <span className="text-[15px] font-medium">{initials(g.name)}</span>}
        </button>
      </Tip>
      {mentions > 0 && <Badge n={mentions} className="absolute -bottom-1.5 right-[8px] border-4 border-rail !h-4 !min-w-4 box-content" />}
    </div>
  );
}

export function ServerRail({ onNavigate }: { onNavigate?: () => void }) {
  const order = useData((s) => s.guildOrder);
  const dms = useData((s) => s.dms); const readStates = useData((s) => s.readStates); const me = useData((s) => s.me);
  const { isHome, channelId } = useRouteIds(); const nav = useNav(); const open = useUI((s) => s.openModal);
  const dmMentions = useMemo(() => Object.values(dms).reduce((a, c) => a + (readStates[c.id]?.mentionCount ?? 0), 0), [dms, readStates]);
  const unreadDms = useData(useShallow((s) => Object.values(s.dms).filter((c) => channelUnread(s, c).unread && channelUnread(s, c).mentions > 0).sort((a, b) => (b.lastMessageId ?? '').localeCompare(a.lastMessageId ?? '')).slice(0, 6).map((c) => c.id)));
  return (
    <nav aria-label="Servers" className="scroller-hide flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail pb-3" style={{ paddingTop: 'calc(12px + var(--sat))' }} onClick={onNavigate}>
      <div className="relative flex w-full justify-center">
        <span className={cx('absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-header transition-all', isHome ? 'h-10' : 'h-0')} />
        <Tip text="Direct Messages">
          <button aria-label="Direct Messages" aria-current={isHome ? 'page' : undefined} onClick={() => nav.go('@me', isHome ? channelId : undefined)} className={cx('flex h-12 w-12 items-center justify-center transition-all hover:rounded-2xl', isHome ? 'rounded-2xl bg-brand' : 'rounded-3xl bg-chat hover:bg-brand')}>
            <LogoGlyph size={32} className={isHome ? 'text-white' : 'text-normal'} />
          </button>
        </Tip>
        {dmMentions > 0 && <Badge n={dmMentions} className="absolute -bottom-1.5 right-[8px] border-4 border-rail !h-4 !min-w-4 box-content" />}
      </div>
      {unreadDms.map((id) => <DmShortcut key={id} id={id} />)}
      <div className="h-0.5 w-8 rounded bg-divider" />
      {order.map((id) => <GuildButton key={id} id={id} />)}
      <Tip text="Add a Server"><button aria-label="Add a Server" onClick={() => open({ kind: 'createServer' })} className="flex h-12 w-12 items-center justify-center rounded-3xl bg-chat text-success transition-all hover:rounded-2xl hover:bg-success hover:text-white"><Plus size={24} /></button></Tip>
      <Tip text="Explore Discoverable Servers"><button aria-label="Explore servers" onClick={() => open({ kind: 'joinServer' })} className="flex h-12 w-12 items-center justify-center rounded-3xl bg-chat text-success transition-all hover:rounded-2xl hover:bg-success hover:text-white"><Compass size={24} /></button></Tip>
      <span className="hidden">{me?.id}</span>
    </nav>
  );
}

function DmShortcut({ id }: { id: string }) {
  const c = useData((s) => s.dms[id]); const me = useData((s) => s.me); const nav = useNav();
  const m = useData((s) => s.readStates[id]?.mentionCount ?? 0);
  if (!c) return null;
  const other = (c.recipients ?? []).find((r) => r.id !== me?.id) ?? c.recipients?.[0];
  return (
    <div className="relative">
      <Tip text={dmName(c, me?.id)}><button aria-label={dmName(c, me?.id)} onClick={() => nav.go('@me', id)}><Avatar user={other} size={48} /></button></Tip>
      <Badge n={m} className="absolute -bottom-1 -right-1 border-4 border-rail !h-4 !min-w-4 box-content" />
    </div>
  );
}
