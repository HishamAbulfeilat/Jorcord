import { createContext, useContext, useMemo, useState } from 'react';
import { Compass, Folder as FolderIcon, FolderOpen, Plus } from 'lucide-react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { snowflake } from '@jorcord/shared';
import { useData, guildUnread, channelUnread } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useLayout } from '@/stores/layout';
import { useNav, useRouteIds } from '@/lib/nav';
import { LogoGlyph } from '@/components/ui/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { Tip } from '@/components/ui/Tooltip';
import { Badge } from '@/components/ui/primitives';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { cx, fileUrl, initials, dmName } from '@/lib/format';
import { folderMenu, guildMenu } from '@/lib/menus';
import { FOLDER_PREFIX, applyDrop, extractGuild, folderOf, isFolderKey, mergeInto, moveGuildToFolder, type RailItem } from '@/lib/railLayout';
import { t } from '@/i18n';
import { useShallow } from 'zustand/react/shallow';
import { plainAttrs } from '@/lib/channelOrder';

const MergeCtx = createContext<string | null>(null);
/** dnd-kit's touch activator and the long-press context menu both want onTouchStart: call both. */
const both = (l: Record<string, any> | undefined, m: Record<string, any>) => ({ ...l, ...m, onTouchStart: (e: any) => { l?.onTouchStart?.(e); m.onTouchStart?.(e); } });

function Pill({ active, unread }: { active: boolean; unread: boolean }) {
  return <span className={cx('absolute start-0 top-1/2 w-1 -translate-y-1/2 rounded-e-full bg-header transition-all', active ? 'h-10' : unread ? 'h-2' : 'h-0')} />;
}

function useGuildState(id: string) {
  const g = useData((s) => s.guilds[id]?.guild);
  const u = useData(useShallow((s) => guildUnread(s, id, useUI.getState().prefs.mutedChannels)));
  const muted = useUI((s) => !!s.prefs.mutedGuilds[id]);
  return { g, ...u, muted };
}

function GuildButton({ id, inFolder }: { id: string; inFolder?: boolean }) {
  const { g, unread, mentions, muted } = useGuildState(id);
  const { guildId } = useRouteIds(); const nav = useNav();
  const last = useUI((s) => s.lastChannel[id]);
  const menu = useMenuTrigger(() => guildMenu(id));
  const mergeTarget = useContext(MergeCtx);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const { setNodeRef: setMergeRef } = useDroppable({ id: 'merge:' + id });
  if (!g) return null;
  const active = guildId === id; const icon = fileUrl(g.icon);
  return (
    <div ref={setNodeRef} data-guild={id} className={cx('relative flex w-full justify-center', isDragging && 'z-20 opacity-80')} style={{ transform: CSS.Transform.toString(transform), transition }} {...plainAttrs(attributes)} {...both(listeners, menu)}>
      <Pill active={active} unread={unread && !muted} />
      <Tip text={g.name}>
        <button aria-label={g.name + (mentions ? `, ${mentions} mentions` : unread ? ', unread' : '')} aria-current={active ? 'page' : undefined} onClick={() => nav.go(id, last)}
          className={cx('group relative flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-150 hover:rounded-2xl', active ? 'rounded-2xl bg-brand text-white' : 'rounded-3xl bg-chat text-normal hover:bg-brand hover:text-white', muted && 'opacity-60', mergeTarget === id && 'rounded-2xl ring-2 ring-brand', inFolder && 'h-10 w-10')}>
          {icon ? <img src={icon} alt="" className="h-full w-full object-cover" draggable={false} /> : <span className="text-[15px] font-medium">{initials(g.name)}</span>}
          <span ref={setMergeRef} aria-hidden className="absolute inset-x-0 top-1/4 bottom-1/4" />
        </button>
      </Tip>
      {mentions > 0 && <Badge n={mentions} className="absolute -bottom-1.5 end-[8px] box-content !h-4 !min-w-4 border-4 border-rail" />}
    </div>
  );
}

function FolderButton({ item, open }: { item: Extract<RailItem, { kind: 'folder' }>; open: boolean }) {
  const key = FOLDER_PREFIX + item.id;
  const toggle = useLayout((s) => s.toggleFolder);
  const guilds = useData((s) => s.guilds); const readStates = useData((s) => s.readStates);
  const mutedCh = useUI((s) => s.prefs.mutedChannels);
  const { guildId } = useRouteIds();
  const menu = useMenuTrigger(() => folderMenu(item.id));
  const mergeTarget = useContext(MergeCtx);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: key });
  const { setNodeRef: setMergeRef } = useDroppable({ id: 'merge:' + key });
  const agg = useMemo(() => {
    let unread = false, mentions = 0;
    for (const g of item.guildIds) { const x = guildUnread({ guilds, readStates } as any, g, mutedCh); unread ||= x.unread; mentions += x.mentions; }
    return { unread, mentions };
  }, [item.guildIds, guilds, readStates, mutedCh]);
  const holdsActive = !!guildId && item.guildIds.includes(guildId);
  const color = item.folder.color ?? '#5865f2';
  const name = item.folder.name || t('Folder');
  return (
    <div ref={setNodeRef} data-folder={item.id} className={cx('relative flex w-full flex-col items-center', isDragging && 'z-20 opacity-80')} style={{ transform: CSS.Transform.toString(transform), transition }} {...plainAttrs(attributes)}>
      <div className="relative flex w-full justify-center" {...both(listeners, menu)}>
        <Pill active={holdsActive && !open} unread={agg.unread && !open} />
        <Tip text={name}>
          <button aria-label={`${name}${agg.mentions ? `, ${agg.mentions} mentions` : ''}`} aria-expanded={open} onClick={() => toggle(item.id)}
            className={cx('relative flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-150 hover:rounded-2xl', open ? 'rounded-2xl' : 'rounded-3xl', mergeTarget === key && 'ring-2 ring-brand')} style={{ background: color + '55' }}>
            {open ? <FolderOpen size={24} style={{ color }} /> : (
              <span className="grid h-9 w-9 grid-cols-2 gap-0.5">
                {item.guildIds.slice(0, 4).map((g) => <MiniGuild key={g} id={g} />)}
              </span>
            )}
            <span ref={setMergeRef} aria-hidden className="absolute inset-x-0 top-1/4 bottom-1/4" />
          </button>
        </Tip>
        {!open && agg.mentions > 0 && <Badge n={agg.mentions} className="absolute -bottom-1.5 end-[8px] box-content !h-4 !min-w-4 border-4 border-rail" />}
      </div>
      {open && (
        <div role="group" aria-label={name} className="mt-1 flex w-12 flex-col items-center gap-2 rounded-3xl py-1" style={{ background: color + '26' }}>
          {item.guildIds.map((g) => <GuildButton key={g} id={g} inFolder />)}
        </div>
      )}
    </div>
  );
}

function MiniGuild({ id }: { id: string }) {
  const g = useData((s) => s.guilds[id]?.guild); const icon = fileUrl(g?.icon);
  return <span className="flex h-4 w-4 items-center justify-center overflow-hidden rounded-full bg-chat text-[7px] font-bold text-normal">{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : initials(g?.name ?? '?').slice(0, 1)}</span>;
}

export function ServerRail({ onNavigate }: { onNavigate?: () => void }) {
  const order = useData((s) => s.guildOrder); const layout = useLayout();
  const items = useMemo(() => layout.items(), [order, layout.order, layout.folders]); // eslint-disable-line
  const dms = useData((s) => s.dms); const readStates = useData((s) => s.readStates);
  const { isHome, channelId } = useRouteIds(); const nav = useNav(); const open = useUI((s) => s.openModal);
  const dmMentions = useMemo(() => Object.values(dms).reduce((a, c) => a + (readStates[c.id]?.mentionCount ?? 0), 0), [dms, readStates]);
  const unreadDms = useData(useShallow((s) => Object.values(s.dms).filter((c) => channelUnread(s, c).unread && channelUnread(s, c).mentions > 0).sort((a, b) => (b.lastMessageId ?? '').localeCompare(a.lastMessageId ?? '')).slice(0, 6).map((c) => c.id)));
  const [mergeTarget, setMerge] = useState<string | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 6 } }));
  const flat = useMemo(() => items.flatMap((i) => (i.kind === 'guild' ? [i.id] : [FOLDER_PREFIX + i.id, ...(layout.openFolders[i.id] ? i.guildIds : [])])), [items, layout.openFolders]);

  const collision: CollisionDetection = (args) => {
    const activeKey = String(args.active.id);
    if (!isFolderKey(activeKey)) {
      const merges = args.droppableContainers.filter((c) => String(c.id).startsWith('merge:') && String(c.id) !== 'merge:' + activeKey);
      const hit = pointerWithin({ ...args, droppableContainers: merges });
      if (hit.length) return [hit[0]!];
    }
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !String(c.id).startsWith('merge:')) });
  };
  const onOver = (e: DragOverEvent) => { const id = e.over ? String(e.over.id) : ''; setMerge(id.startsWith('merge:') ? id.slice(6) : null); };
  const onEnd = (e: DragEndEvent) => {
    setMerge(null);
    if (!e.over) return;
    const active = String(e.active.id); const over = String(e.over.id);
    if (over.startsWith('merge:')) {
      const target = over.slice(6); let its = items;
      const tf = isFolderKey(target) ? undefined : folderOf(its, target);
      if (tf) { if (folderOf(its, active)?.id === tf.id) return; its = moveGuildToFolder(its, active, tf.id); }
      else { if (folderOf(its, active)) its = extractGuild(its, active); const id = snowflake(); const before = its; its = mergeInto(before, active, target, () => id); if (!isFolderKey(target)) useLayout.setState((s) => ({ openFolders: { ...s.openFolders, [id]: true } })); }
      layout.commit(its); return;
    }
    layout.commit(applyDrop(items, active, over));
  };

  return (
    <nav aria-label={t('Servers')} className="scroller-hide flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail pb-3" style={{ paddingTop: 'calc(12px + var(--sat))' }} onClick={onNavigate}>
      <div className="relative flex w-full justify-center">
        <Pill active={isHome} unread={false} />
        <Tip text={t('Direct Messages')}>
          <button aria-label={t('Direct Messages')} aria-current={isHome ? 'page' : undefined} onClick={() => nav.go('@me', isHome ? channelId : undefined)} className={cx('flex h-12 w-12 items-center justify-center transition-all hover:rounded-2xl', isHome ? 'rounded-2xl bg-brand' : 'rounded-3xl bg-chat hover:bg-brand')}>
            <LogoGlyph size={32} className={isHome ? 'text-white' : 'text-normal'} />
          </button>
        </Tip>
        {dmMentions > 0 && <Badge n={dmMentions} className="absolute -bottom-1.5 end-[8px] box-content !h-4 !min-w-4 border-4 border-rail" />}
      </div>
      {unreadDms.map((id) => <DmShortcut key={id} id={id} />)}
      <div className="h-0.5 w-8 rounded bg-divider" />
      <MergeCtx.Provider value={mergeTarget}>
        <DndContext sensors={sensors} collisionDetection={collision} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setMerge(null)}>
          <SortableContext items={flat} strategy={verticalListSortingStrategy}>
            {items.map((it) => it.kind === 'guild' ? <GuildButton key={it.id} id={it.id} /> : <FolderButton key={it.id} item={it} open={!!layout.openFolders[it.id]} />)}
          </SortableContext>
        </DndContext>
      </MergeCtx.Provider>
      <Tip text={t('Add a Server')}><button aria-label={t('Add a Server')} onClick={() => open({ kind: 'createServer' })} className="flex h-12 w-12 items-center justify-center rounded-3xl bg-chat text-success transition-all hover:rounded-2xl hover:bg-success hover:text-white"><Plus size={24} /></button></Tip>
      <Tip text={t('Explore Discoverable Servers')}><button aria-label={t('Explore servers')} onClick={() => nav.to('/discover')} className="flex h-12 w-12 items-center justify-center rounded-3xl bg-chat text-success transition-all hover:rounded-2xl hover:bg-success hover:text-white"><Compass size={24} /></button></Tip>
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
      <Badge n={m} className="absolute -bottom-1 -end-1 box-content !h-4 !min-w-4 border-4 border-rail" />
    </div>
  );
}
void FolderIcon;
