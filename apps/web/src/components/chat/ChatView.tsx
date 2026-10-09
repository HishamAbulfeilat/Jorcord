import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, Hash, Menu, MessagesSquare, Pin, Search, Upload, Users, X, AtSign, ArrowLeft, UserPlus } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { TypingIndicator } from './TypingIndicator';
import { MemberList, DmMemberPanel } from './MemberList';
import { SearchPanel, PinsPanel, ThreadsPanel } from './Panels';
import { ChannelIcon } from '@/components/layout/ChannelSidebar';
import { Tip } from '@/components/ui/Tooltip';
import { Avatar } from '@/components/ui/Avatar';
import { cx, dmName } from '@/lib/format';
import { useIsMobile, useIsNarrow } from '@/lib/hooks';
import { setCurrentChannel } from '@/lib/session';
import { useNav } from '@/lib/nav';
import { Markdown } from './Markdown';
import { markChannelRead } from '@/lib/menus';

export function HeaderButton({ label, active, onClick, children, badge }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; badge?: boolean }) {
  return <Tip text={label} side="bottom"><button aria-label={label} aria-pressed={active} onClick={onClick} className={cx('touch relative flex h-8 min-w-8 items-center justify-center rounded px-1 md:min-h-0', active ? 'text-header' : 'text-interactive hover:text-interactive-hover')}>{children}{badge && <span className="absolute right-0.5 top-0 h-2 w-2 rounded-full bg-danger" />}</button></Tip>;
}

export function ChannelHeader({ channel }: { channel: Channel }) {
  const me = useData((s) => s.me); const panel = useUI((s) => s.panel); const toggle = useUI((s) => s.togglePanel); const setLeft = useUI((s) => s.setLeftDrawer); const setRight = useUI((s) => s.setRightDrawer);
  const muted = useUI((s) => !!s.prefs.mutedChannels[channel.id]); const setPref = useUI((s) => s.setPref); const prefs = useUI((s) => s.prefs);
  const mobile = useIsMobile(); const nav = useNav(); const openModal = useUI((s) => s.openModal);
  const isDm = channel.type === 'dm' || channel.type === 'group_dm'; const isThread = channel.type === 'thread';
  const other = isDm ? (channel.recipients ?? []).find((r) => r.id !== me?.id) ?? channel.recipients?.[0] : undefined;
  const mentions = useData((s) => Object.values(s.readStates).reduce((a, r) => a + r.mentionCount, 0) - (s.readStates[channel.id]?.mentionCount ?? 0));
  const unreadElsewhere = mentions > 0;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content md:px-4">
      {mobile && <button aria-label="Open navigation" onClick={() => setLeft(true)} className="relative flex h-11 w-11 items-center justify-center text-interactive"><Menu size={24} />{unreadElsewhere && <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-danger" />}</button>}
      {isThread && channel.parentId && <button aria-label="Back to parent channel" onClick={() => nav.go(channel.guildId, channel.parentId)} className="text-interactive hover:text-header"><ArrowLeft size={20} /></button>}
      {isDm ? (other ? <Avatar user={other} size={24} presence /> : <Users size={24} className="text-muted" />) : isThread ? <MessagesSquare size={22} className="text-muted" /> : <ChannelIcon c={channel} size={24} className="shrink-0 text-muted" />}
      {isDm && <AtSign size={0} />}
      <h1 className="truncate text-base font-semibold text-header">{isDm ? dmName(channel, me?.id) : channel.name}</h1>
      {channel.topic && !mobile && <><span className="mx-1 h-6 w-px bg-divider" aria-hidden /><div className="min-w-0 flex-1 truncate text-sm text-muted" title={channel.topic}><Markdown content={channel.topic} guildId={channel.guildId} inline /></div></>}
      <div className="ml-auto flex items-center gap-1 md:gap-2">
        {!isDm && !isThread && <HeaderButton label="Threads" active={panel === 'threads'} onClick={() => toggle('threads')}><MessagesSquare size={24} /></HeaderButton>}
        {!mobile && <HeaderButton label={muted ? 'Unmute Channel' : 'Mute Channel'} onClick={() => setPref('mutedChannels', { ...prefs.mutedChannels, [channel.id]: !muted })}>{muted ? <BellOff size={24} /> : <Bell size={24} />}</HeaderButton>}
        <HeaderButton label="Pinned Messages" active={panel === 'pins'} onClick={() => toggle('pins')}><Pin size={24} /></HeaderButton>
        {isDm && channel.type === 'dm' && !mobile && <HeaderButton label="Add Friends to DM" onClick={() => openModal({ kind: 'newDm' })}><UserPlus size={24} /></HeaderButton>}
        {(!isDm || channel.type === 'group_dm') && <HeaderButton label="Member List" active={mobile ? undefined : panel === 'members'} onClick={() => (mobile ? setRight(true) : toggle('members'))}><Users size={24} /></HeaderButton>}
        {mobile ? <HeaderButton label="Search" onClick={() => toggle('search')}><Search size={22} /></HeaderButton> : (
          <button onClick={() => toggle('search')} aria-label="Search" className={cx('flex h-6 w-36 items-center justify-between rounded bg-rail px-1.5 text-left text-[13px] text-muted transition-all hover:w-44', panel === 'search' && 'w-44')}>Search<Search size={14} /></button>
        )}
      </div>
    </header>
  );
}

export function ChatView({ channel }: { channel: Channel }) {
  const cid = channel.id; const gid = channel.guildId;
  const panel = useUI((s) => s.panel); const setPanel = useUI((s) => s.setPanel); const rightDrawer = useUI((s) => s.rightDrawer); const setRight = useUI((s) => s.setRightDrawer);
  const setLast = useUI((s) => s.setLastChannel); const mobile = useIsMobile(); const narrow = useIsNarrow();
  const snapshot = useRef<{ cid: string; v: string | null }>({ cid: '', v: null });
  if (snapshot.current.cid !== cid) snapshot.current = { cid, v: useData.getState().readStates[cid]?.lastReadId ?? null };
  const [drag, setDrag] = useState(false); const [dropped, setDropped] = useState<File[]>([]); const depth = useRef(0);
  const isDm = !gid;

  useEffect(() => { setCurrentChannel(cid); if (gid) setLast(gid, cid); return () => setCurrentChannel(null); }, [cid, gid, setLast]);
  useEffect(() => { useUI.getState().setEditing(null); }, [cid]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('textarea,input,[role=dialog]') && !useUI.getState().modal) markChannelRead(channel); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [channel]);

  const rightPanel = useMemo(() => {
    if (panel === 'search') return <SearchPanel guildId={gid ?? undefined} channel={channel} onClose={() => setPanel(null)} />;
    if (panel === 'pins') return <PinsPanel channel={channel} onClose={() => setPanel(null)} />;
    if (panel === 'threads' && gid) return <ThreadsPanel channel={channel} onClose={() => setPanel('members')} />;
    if (panel === 'members' && !mobile && !narrow) return gid ? <MemberList guildId={gid} /> : channel.type === 'group_dm' ? <DmMemberPanel channelId={cid} /> : null;
    return null;
  }, [panel, gid, channel, cid, mobile, narrow, setPanel]);

  const overlay = mobile && panel && panel !== 'members';
  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-chat"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { depth.current++; setDrag(true); } }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDrag(false); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); depth.current = 0; setDrag(false); const fs = [...e.dataTransfer.files]; if (fs.length) setDropped(fs); }}>
      <ChannelHeader channel={channel} />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <MessageList key={cid} channel={channel} lastReadSnapshot={snapshot.current.v} />
          <div className="relative"><TypingIndicator channelId={cid} guildId={gid} /></div>
          <Composer key={'c' + cid} channel={channel} stagedExternal={dropped} />
          {drag && (
            <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-brand/20 backdrop-blur-sm" aria-hidden>
              <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-brand bg-chat/90 px-10 py-8 text-header"><Upload size={40} className="text-brand" /><div className="text-lg font-bold">Upload to {isDm ? dmName(channel, undefined) : `#${channel.name}`}</div><div className="text-sm text-muted">You can add comments before uploading.</div></div>
            </div>
          )}
        </div>
        {!mobile && rightPanel && <div className="hidden shrink-0 md:block">{rightPanel}</div>}
      </div>
      {overlay && <div className="absolute inset-0 z-30 animate-slideUp bg-side">{rightPanel}</div>}
      {mobile && gid && <MobileMembers open={rightDrawer} close={() => setRight(false)} guildId={gid} />}
      {mobile && !gid && channel.type === 'group_dm' && <MobileMembers open={rightDrawer} close={() => setRight(false)} dm={cid} />}
      {narrow && !mobile && panel === 'members' && (gid || channel.type === 'group_dm') && (
        <div className="absolute inset-y-0 right-0 z-30 shadow-elev">{gid ? <MemberList guildId={gid} /> : <DmMemberPanel channelId={cid} />}</div>
      )}
    </div>
  );
}

function MobileMembers({ open, close, guildId, dm }: { open: boolean; close: () => void; guildId?: string; dm?: string }) {
  return (
    <>
      <div className={cx('fixed inset-0 z-40 bg-black/60 transition-opacity', open ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={close} aria-hidden />
      <div role="dialog" aria-label="Members" aria-hidden={!open} className={cx('drawer fixed inset-y-0 right-0 z-50 flex w-[85%] max-w-[320px] flex-col bg-side safe-top', open ? 'translate-x-0' : 'translate-x-full')}>
        <div className="flex h-12 items-center justify-between px-4"><span className="font-bold text-header">Members</span><button aria-label="Close members" onClick={close} className="flex h-11 w-11 items-center justify-center"><X size={22} /></button></div>
        <div className="min-h-0 flex-1 [&>aside]:w-full">{guildId ? <MemberList guildId={guildId} /> : dm ? <DmMemberPanel channelId={dm} /> : null}</div>
      </div>
    </>
  );
}
void Hash;
