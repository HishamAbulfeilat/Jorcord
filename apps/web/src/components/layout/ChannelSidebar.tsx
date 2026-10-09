import { ChevronDown, ChevronRight, Hash, Megaphone, MessagesSquare, Plus, Radio, UserPlus, Volume2, Settings, X, Lock, Volume1 } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { useData, channelUnread } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useNav, useRouteIds } from '@/lib/nav';
import { useGuildPerms, useSidebarChannels } from '@/lib/useGuild';
import { can, canOpenGuildSettings } from '@/lib/perms';
import { channelMenu, guildMenu } from '@/lib/menus';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { Badge } from '@/components/ui/primitives';
import { Avatar } from '@/components/ui/Avatar';
import { cx, fileUrl, displayName } from '@/lib/format';
import { Tip } from '@/components/ui/Tooltip';
import { useShallow } from 'zustand/react/shallow';

export const ChannelIcon = ({ c, size = 20, className = '' }: { c: Pick<Channel, 'type' | 'overwrites'>; size?: number; className?: string }) => {
  const priv = c.overwrites?.some((o) => o.type === 'role' && (BigInt(o.deny || 0) & Perm.VIEW_CHANNEL) !== 0n);
  if (c.type === 'voice') return priv ? <Volume1 size={size} className={className} /> : <Volume2 size={size} className={className} />;
  if (c.type === 'stage') return <Radio size={size} className={className} />;
  if (c.type === 'announcement') return <Megaphone size={size} className={className} />;
  if (c.type === 'forum') return <MessagesSquare size={size} className={className} />;
  return priv ? <Lock size={size - 4} className={className} /> : <Hash size={size} className={className} />;
};

function VoiceMembers({ channelId }: { channelId: string }) {
  const users = useData(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId).map((v) => s.users[v.userId]).filter(Boolean)));
  if (!users.length) return null;
  return <ul className="mb-1 ml-8 space-y-0.5">{users.map((u) => <li key={u.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-interactive"><Avatar user={u} size={20} /><span className="truncate">{displayName(u)}</span></li>)}</ul>;
}

function ChannelRow({ c, guildId, canManage, canInvite }: { c: Channel; guildId: string; canManage: boolean; canInvite: boolean }) {
  const nav = useNav(); const { channelId } = useRouteIds();
  const { unread, mentions } = useData(useShallow((s) => channelUnread(s, c)));
  const muted = useUI((s) => !!s.prefs.mutedChannels[c.id]);
  const open = useUI((s) => s.openModal);
  const trig = useMenuTrigger(() => channelMenu(c));
  const active = channelId === c.id;
  const emph = (unread || mentions > 0) && !muted;
  return (
    <li>
      <div className={cx('group relative mx-2 flex items-center rounded', active ? 'bg-active text-header' : 'hover:bg-hover', emph ? 'text-header' : active ? '' : 'text-muted hover:text-interactive-hover', muted && !active && 'opacity-50')} {...trig}>
        {emph && !active && <span className="pill-unread" style={{ left: -8 }} />}
        <button aria-current={active ? 'page' : undefined} onClick={() => nav.go(guildId, c.id)} className="touch flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left md:min-h-[34px]">
          <ChannelIcon c={c} className="shrink-0 opacity-70" />
          <span className={cx('truncate text-[16px] leading-5', emph ? 'font-semibold' : 'font-medium')}>{c.name}</span>
        </button>
        <span className="flex items-center gap-1 pr-2">
          {canInvite && c.type !== 'voice' && <button aria-label="Create Invite" onClick={() => open({ kind: 'invite', guildId, channelId: c.id })} className="hidden text-interactive hover:text-header group-hover:block md:group-hover:block"><UserPlus size={16} /></button>}
          {canManage && <button aria-label="Edit Channel" onClick={() => open({ kind: 'channelSettings', channelId: c.id })} className="hidden text-interactive hover:text-header group-hover:block"><Settings size={16} /></button>}
          {mentions > 0 && <Badge n={mentions} />}
        </span>
      </div>
      {(c.type === 'voice' || c.type === 'stage') && <VoiceMembers channelId={c.id} />}
    </li>
  );
}

export function ChannelSidebar({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId]?.guild);
  const { uncategorized, categories } = useSidebarChannels(guildId);
  const perms = useGuildPerms(guildId);
  const prefs = useUI((s) => s.prefs); const setPref = useUI((s) => s.setPref); const open = useUI((s) => s.openModal);
  const openMenu = useUI((s) => s.openMenu); const { channelId } = useRouteIds();
  const readStates = useData((s) => s.readStates);
  const canManage = can(perms, Perm.MANAGE_CHANNELS); const canInvite = can(perms, Perm.CREATE_INVITE);
  if (!g) return <div className="flex-1" />;
  const banner = fileUrl(g.banner);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button aria-haspopup="menu" aria-label={`${g.name} server menu`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left + 8, r.bottom + 4, guildMenu(guildId)); }}
        className={cx('relative flex h-12 shrink-0 items-center justify-between px-4 text-left font-bold text-header shadow-[0_1px_0_rgb(0_0_0/0.2)] hover:bg-hover safe-top box-content', banner && 'h-[84px] items-end pb-2')}
        style={banner ? { backgroundImage: `linear-gradient(transparent,rgb(0 0 0/.6)),url(${banner})`, backgroundSize: 'cover' } : undefined}>
        <span className="truncate text-[15px]">{g.name}</span>
        <ChevronDown size={18} />
      </button>
      <div className="scroller min-h-0 flex-1 pb-4 pt-2" role="navigation" aria-label="Channels">
        <ul className="mb-1">{uncategorized.map((c) => <ChannelRow key={c.id} c={c} guildId={guildId} canManage={canManage} canInvite={canInvite} />)}</ul>
        {categories.map(({ cat, children }) => {
          const collapsed = !!prefs.collapsedCategories[cat.id];
          const shown = collapsed ? children.filter((c) => c.id === channelId || channelUnread({ readStates } as any, c).unread) : children;
          return (
            <section key={cat.id} className="mt-4 first:mt-0">
              <CategoryHeader cat={cat} collapsed={collapsed} toggle={() => setPref('collapsedCategories', { ...prefs.collapsedCategories, [cat.id]: !collapsed })} canManage={canManage} onAdd={() => open({ kind: 'createChannel', guildId, parentId: cat.id })} />
              <ul>{shown.map((c) => <ChannelRow key={c.id} c={c} guildId={guildId} canManage={canManage} canInvite={canInvite} />)}</ul>
            </section>
          );
        })}
        {!uncategorized.length && !categories.length && <p className="px-4 py-6 text-center text-sm text-muted">No channels yet.</p>}
      </div>
    </div>
  );
}

function CategoryHeader({ cat, collapsed, toggle, canManage, onAdd }: { cat: Channel; collapsed: boolean; toggle: () => void; canManage: boolean; onAdd: () => void }) {
  const trig = useMenuTrigger(() => channelMenu(cat));
  return (
    <div className="group flex items-center pr-2 text-muted hover:text-interactive-hover" {...trig}>
      <button aria-expanded={!collapsed} onClick={toggle} className="touch flex min-w-0 flex-1 items-center gap-0.5 px-2 text-left md:min-h-[26px]">
        {collapsed ? <ChevronRight size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />}
        <span className="truncate text-xs font-bold uppercase tracking-wide">{cat.name}</span>
      </button>
      {canManage && <Tip text="Create Channel" side="top"><button aria-label={`Create channel in ${cat.name}`} onClick={onAdd} className="text-interactive hover:text-header"><Plus size={18} /></button></Tip>}
    </div>
  );
}
void X;
