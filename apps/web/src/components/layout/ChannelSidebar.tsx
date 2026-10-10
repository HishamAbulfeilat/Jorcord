import { useMemo, useRef } from 'react';
import { useRovingTabindex } from '@/lib/hooks';
import { CalendarDays, ChevronDown, ChevronRight, Hash, Megaphone, MessagesSquare, Plus, Radio, UserPlus, Volume2, Settings, X, Lock, Volume1, Video, VolumeX, MicOff } from 'lucide-react';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { joinVoice } from '@/voice/controller';
import { voiceUserMenu } from '@/voice/menu';
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
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import { toastError } from '@/stores/ui';
import { CAT, applyChannelDrop, layoutOf, orderDiff, plainAttrs } from '@/lib/channelOrder';
import { t } from '@/i18n';
import { usePlatform } from '@/stores/platform';
import { useLoadEvents } from '@/components/modals/PlatformModals';
import { useGuildStages } from '@/voice/StageBar';
import { isLive, isUpcoming } from '@/lib/events';

export const ChannelIcon = ({ c, size = 20, className = '' }: { c: Pick<Channel, 'type' | 'overwrites'>; size?: number; className?: string }) => {
  const priv = c.overwrites?.some((o) => o.type === 'role' && (BigInt(o.deny || 0) & Perm.VIEW_CHANNEL) !== 0n);
  if (c.type === 'voice') return priv ? <Volume1 size={size} className={className} /> : <Volume2 size={size} className={className} />;
  if (c.type === 'stage') return <Radio size={size} className={className} />;
  if (c.type === 'announcement') return <Megaphone size={size} className={className} />;
  if (c.type === 'forum') return <MessagesSquare size={size} className={className} />;
  return priv ? <Lock size={size - 4} className={className} /> : <Hash size={size} className={className} />;
};

/** "N Events" row under the server header (Discord's sidebar entry): opens the events list. */
function EventsEntry({ guildId }: { guildId: string }) {
  useLoadEvents(guildId);
  const evMap = usePlatform((s) => s.events[guildId]); const open = useUI((s) => s.openModal);
  const upcoming = useMemo(() => Object.values(evMap ?? {}).filter(isUpcoming), [evMap]); const live = upcoming.some(isLive);
  const perms = useGuildPerms(guildId);
  if (!upcoming.length && !can(perms, Perm.CREATE_EVENTS)) return null;
  return (
    <button data-testid="events-entry" onClick={() => open({ kind: 'events', guildId })} className="mx-2 mt-2 flex items-center gap-2 rounded px-2 py-1.5 text-start text-sm font-medium text-interactive hover:bg-hover hover:text-interactive-hover">
      <CalendarDays size={20} className={live ? 'text-success' : undefined} aria-hidden />
      <span className="flex-1 truncate">{upcoming.length ? `${upcoming.length} ${upcoming.length === 1 ? t('Event') : t('Events')}` : t('Events')}</span>
      {live && <span className="h-2 w-2 rounded-full bg-success" aria-label={t('Live')} />}
    </button>
  );
}

function VoiceMemberRow({ userId, channelId, speaking, children }: { userId: string; channelId: string; speaking: boolean; children: React.ReactNode }) {
  const trig = useMenuTrigger(() => voiceUserMenu(userId, channelId));
  return <li data-speaking={speaking} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-interactive hover:bg-hover" {...trig}>{children}</li>;
}

function VoiceMembers({ channelId }: { channelId: string }) {
  const states = useData(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId)));
  const users = useData(useShallow((s) => states.map((v) => s.users[v.userId])));
  const snap = useVoiceSnapshot();
  if (!states.length) return null;
  return (
    <ul className="mb-1 ms-8 space-y-0.5" aria-label={t('Voice participants')}>
      {states.map((v, i) => {
        const u = users[i]; if (!u) return null;
        const live = snap.channelId === channelId ? snap.participants.find((p) => p.identity === v.userId) : undefined;
        const speaking = !!live?.speaking;
        return (
          <VoiceMemberRow key={v.userId} userId={v.userId} channelId={channelId} speaking={speaking}>
            <span className={cx('rounded-full', speaking && 'shadow-[0_0_0_2px_rgb(var(--success))]')} style={{ lineHeight: 0 }}><Avatar user={u} size={20} /></span>
            <span className="truncate">{displayName(u)}</span>
            <span className="ms-auto flex items-center gap-1 text-muted">
              {v.streaming && <span className="rounded bg-danger px-1 text-[10px] font-bold uppercase leading-4 text-white">{t('Live')}</span>}
              {v.video && <Video size={14} aria-label={t('Camera on')} />}
              {v.selfDeaf || v.serverDeaf ? <VolumeX size={14} className="text-danger" aria-label={t('Deafened')} /> : v.selfMute || v.serverMute ? <MicOff size={14} className="text-danger" aria-label={t('Muted')} /> : null}
            </span>
          </VoiceMemberRow>
        );
      })}
    </ul>
  );
}

function ChannelRow({ c, guildId, canManage, canInvite }: { c: Channel; guildId: string; canManage: boolean; canInvite: boolean }) {
  const nav = useNav(); const { channelId } = useRouteIds();
  const { unread, mentions } = useData(useShallow((s) => channelUnread(s, c)));
  const muted = useUI((s) => !!s.prefs.mutedChannels[c.id]);
  const open = useUI((s) => s.openModal);
  const trig = useMenuTrigger(() => channelMenu(c));
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id, disabled: !canManage });
  const active = channelId === c.id;
  const stage = usePlatform((s) => (c.type === 'stage' ? s.stages[c.id] : undefined));
  const emph = (unread || mentions > 0) && !muted;
  return (
    <li ref={setNodeRef} data-channel={c.id} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx(isDragging && 'relative z-20 opacity-80')} {...plainAttrs(attributes)} {...listeners}>
      <div className={cx('group relative mx-2 flex items-center rounded', active ? 'bg-active text-header' : 'hover:bg-hover', emph ? 'text-header' : active ? '' : 'text-muted hover:text-interactive-hover', muted && !active && 'opacity-50')} {...trig}>
        {emph && !active && <span className="pill-unread" style={{ insetInlineStart: -8 }} />}
        <button aria-current={active ? 'page' : undefined} onClick={() => { nav.go(guildId, c.id); if (c.type === 'voice' || c.type === 'stage') void joinVoice(c.id); }} className="touch flex min-w-0 flex-1 items-center gap-1.5 px-2 text-start md:min-h-[34px]">
          <ChannelIcon c={c} className="shrink-0 opacity-70" />
          <span className={cx('truncate text-[16px] leading-5', emph ? 'font-semibold' : 'font-medium')}>{c.name}</span>
        </button>
        <span className="flex items-center gap-1 pe-2">
          {canInvite && c.type !== 'voice' && <button aria-label={t('Create Invite')} onClick={() => open({ kind: 'invite', guildId, channelId: c.id })} className="hidden text-interactive hover:text-header group-hover:block group-focus-within:block"><UserPlus size={16} /></button>}
          {canManage && <button aria-label={t('Edit Channel')} onClick={() => open({ kind: 'channelSettings', channelId: c.id })} className="hidden text-interactive hover:text-header group-hover:block group-focus-within:block"><Settings size={16} /></button>}
          {mentions > 0 && <Badge n={mentions} />}
        </span>
      </div>
      {stage && <div data-testid="stage-live" className="mx-2 -mt-0.5 mb-1 ms-[34px] truncate text-xs text-success" title={stage.topic}><span aria-hidden>● </span><span className="sr-only">{t('Live')}: </span>{stage.topic}</div>}
      {(c.type === 'voice' || c.type === 'stage') && <VoiceMembers channelId={c.id} />}
    </li>
  );
}

function CategorySection({ cat, items, collapsed, toggle, canManage, onAdd, render }: { cat: Channel; items: Channel[]; collapsed: boolean; toggle: () => void; canManage: boolean; onAdd: () => void; render: (c: Channel) => React.ReactNode }) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id: CAT + cat.id, disabled: !canManage });
  return (
    <section ref={setNodeRef} data-category={cat.id} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx('mt-4 first:mt-0', isDragging && 'relative z-20 opacity-80')}>
      <CategoryHeader cat={cat} collapsed={collapsed} toggle={toggle} canManage={canManage} onAdd={onAdd} dragProps={{ ...plainAttrs(attributes), ...listeners }} />
      <SortableContext items={items.map((c) => c.id)} strategy={verticalListSortingStrategy}><ul>{items.map(render)}</ul></SortableContext>
    </section>
  );
}

export function ChannelSidebar({ guildId }: { guildId: string }) {
  const listRef = useRef<HTMLDivElement>(null); useRovingTabindex(listRef, '[data-channel] > div > button:first-child');
  const g = useData((s) => s.guilds[guildId]?.guild);
  const channels = useData((s) => s.guilds[guildId]?.channels);
  const { uncategorized, categories } = useSidebarChannels(guildId);
  const perms = useGuildPerms(guildId);
  const prefs = useUI((s) => s.prefs); const setPref = useUI((s) => s.setPref); const open = useUI((s) => s.openModal);
  const openMenu = useUI((s) => s.openMenu); const { channelId } = useRouteIds();
  const readStates = useData((s) => s.readStates);
  useGuildStages(guildId);
  const canManage = can(perms, Perm.MANAGE_CHANNELS); const canInvite = can(perms, Perm.CREATE_INVITE);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 6 } }));
  if (!g) return <div className="flex-1" />;
  const banner = fileUrl(g.banner);
  const collision: CollisionDetection = (args) => {
    const isCat = String(args.active.id).startsWith(CAT);
    return closestCenter({ ...args, droppableContainers: isCat ? args.droppableContainers.filter((c) => String(c.id).startsWith(CAT)) : args.droppableContainers });
  };
  const onEnd = async (e: DragEndEvent) => {
    if (!e.over || !channels) return;
    const layout = layoutOf(uncategorized, categories);
    const next = applyChannelDrop(layout, String(e.active.id), String(e.over.id));
    if (next === layout) return;
    const diff = orderDiff(next, channels);
    if (!diff.length) return;
    // optimistic: update the store, roll back on failure
    const before = diff.map((d) => channels[d.id]!).filter(Boolean);
    diff.forEach((d) => useData.getState().apply('CHANNEL_UPDATE', { ...channels[d.id]!, position: d.position, parentId: d.parentId }));
    try { await api.guilds.reorderChannels(guildId, diff); } catch (err) { before.forEach((c) => useData.getState().apply('CHANNEL_UPDATE', c)); toastError(err); }
  };
  const row = (c: Channel) => <ChannelRow key={c.id} c={c} guildId={guildId} canManage={canManage} canInvite={canInvite} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button aria-haspopup="menu" aria-label={t('{name} server menu', { name: g.name })} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left + 8, r.bottom + 4, guildMenu(guildId)); }}
        className={cx('relative flex h-12 shrink-0 items-center justify-between px-4 text-start font-bold text-header shadow-[0_1px_0_rgb(0_0_0/0.2)] hover:bg-hover safe-top box-content', banner && 'h-[84px] items-end pb-2')}
        style={banner ? { backgroundImage: `linear-gradient(transparent,rgb(0 0 0/.6)),url(${banner})`, backgroundSize: 'cover' } : undefined}>
        <span className="truncate text-[15px]">{g.name}</span>
        <ChevronDown size={18} />
      </button>
      <EventsEntry guildId={guildId} />
      <div ref={listRef} className="scroller min-h-0 flex-1 pb-4 pt-2" role="navigation" aria-label={t('Channels')}>
        <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onEnd}>
          <SortableContext items={uncategorized.map((c) => c.id)} strategy={verticalListSortingStrategy}><ul className="mb-1">{uncategorized.map(row)}</ul></SortableContext>
          <SortableContext items={categories.map(({ cat }) => CAT + cat.id)} strategy={verticalListSortingStrategy}>
            {categories.map(({ cat, children }) => {
              const collapsed = !!prefs.collapsedCategories[cat.id];
              const shown = collapsed ? children.filter((c) => c.id === channelId || channelUnread({ readStates } as any, c).unread) : children;
              return <CategorySection key={cat.id} cat={cat} items={shown} collapsed={collapsed} toggle={() => setPref('collapsedCategories', { ...prefs.collapsedCategories, [cat.id]: !collapsed })} canManage={canManage} onAdd={() => open({ kind: 'createChannel', guildId, parentId: cat.id })} render={row} />;
            })}
          </SortableContext>
        </DndContext>
        {!uncategorized.length && !categories.length && <p className="px-4 py-6 text-center text-sm text-muted">{t('No channels yet.')}</p>}
      </div>
    </div>
  );
}

function CategoryHeader({ cat, collapsed, toggle, canManage, onAdd, dragProps }: { cat: Channel; collapsed: boolean; toggle: () => void; canManage: boolean; onAdd: () => void; dragProps?: Record<string, unknown> }) {
  const trig = useMenuTrigger(() => channelMenu(cat));
  return (
    <div className="group flex items-center pe-2 text-muted hover:text-interactive-hover" {...trig} {...dragProps}>
      <button aria-expanded={!collapsed} onClick={toggle} className="touch flex min-w-0 flex-1 items-center gap-0.5 px-2 text-start md:min-h-[26px]">
        {collapsed ? <ChevronRight size={12} strokeWidth={3} className="rtl:rotate-180" /> : <ChevronDown size={12} strokeWidth={3} />}
        <span className="truncate text-xs font-bold uppercase tracking-wide">{cat.name}</span>
      </button>
      {canManage && <Tip text={t('Create Channel')} side="top"><button aria-label={t('Create channel in {name}', { name: cat.name ?? '' })} onClick={onAdd} className="flex h-6 w-6 items-center justify-center rounded text-interactive hover:text-header"><Plus size={18} /></button></Tip>}
    </div>
  );
}
void X;
