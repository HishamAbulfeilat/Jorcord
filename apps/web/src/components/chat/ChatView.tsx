import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, Bell, BellOff, Hash, Menu, MessagesSquare, Pin, Search, Upload, Users, X, AtSign, ArrowLeft, UserPlus, Inbox } from 'lucide-react';
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
import { lazyNamed, Lazy } from '@/lib/lazy';
const DmCallPanel = lazyNamed(() => import('@/voice/DmCall'), 'DmCallPanel');
/** Load the call surface lazily; the header buttons only need it when a call starts. */
const startDmCall = (channelId: string, video: boolean) => import('@/voice/DmCall').then((m) => m.startCall(channelId, video));
import { Phone, Video, Film, Settings as Cog, Lock, Archive } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { selfMember } from '@/stores/data';
import { api } from '@/lib/api';
import { toastError } from '@/stores/ui';
import { t } from '@/i18n';

export function HeaderButton({ label, active, onClick, children, badge }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; badge?: boolean }) {
  return <Tip text={label} side="bottom"><button aria-label={label} aria-pressed={active} onClick={onClick} className={cx('touch relative flex h-8 min-w-8 items-center justify-center rounded px-1 md:min-h-0', active ? 'text-header' : 'text-interactive hover:text-interactive-hover')}>{children}{badge && <span className="absolute end-0.5 top-0 h-2 w-2 rounded-full bg-danger" />}</button></Tip>;
}

export function ChannelHeader({ channel }: { channel: Channel }) {
  const me = useData((s) => s.me); const panel = useUI((s) => s.panel); const toggle = useUI((s) => s.togglePanel); const setLeft = useUI((s) => s.setLeftDrawer); const setRight = useUI((s) => s.setRightDrawer);
  const muted = useUI((s) => !!s.prefs.mutedChannels[channel.id]); const setPref = useUI((s) => s.setPref); const prefs = useUI((s) => s.prefs);
  const mobile = useIsMobile(); const nav = useNav(); const openModal = useUI((s) => s.openModal);
  const isDm = channel.type === 'dm' || channel.type === 'group_dm'; const isThread = channel.type === 'thread';
  const other = isDm ? (channel.recipients ?? []).find((r) => r.id !== me?.id) ?? channel.recipients?.[0] : undefined;
  const mentions = useData((s) => Object.values(s.readStates).reduce((a, r) => a + r.mentionCount, 0) - (s.readStates[channel.id]?.mentionCount ?? 0));
  const unreadElsewhere = mentions > 0;
  const dueReminders = useQuery({ queryKey: ['inbox', 'reminders'], queryFn: api.users.reminders, staleTime: 60_000, retry: false }).data?.some((r) => r.firedAt) ?? false;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content md:px-4">
      {mobile && <button aria-label={t('Open navigation')} onClick={() => setLeft(true)} className="relative flex h-11 w-11 items-center justify-center text-interactive"><Menu size={24} />{unreadElsewhere && <span className="absolute end-2 top-2 h-2.5 w-2.5 rounded-full bg-danger" />}</button>}
      {isThread && channel.parentId && <button aria-label={t('Back to parent channel')} onClick={() => nav.go(channel.guildId, channel.parentId)} className="text-interactive hover:text-header"><ArrowLeft size={20} /></button>}
      {isDm ? (other ? <Avatar user={other} size={24} presence /> : <Users size={24} className="text-muted" />) : isThread ? <MessagesSquare size={22} className="text-muted" /> : <ChannelIcon c={channel} size={24} className="shrink-0 text-muted" />}
      {isDm && <AtSign size={0} />}
      <h1 className="truncate text-base font-semibold text-header">{isDm ? dmName(channel, me?.id) : channel.name}</h1>
      {isThread && channel.locked && <Lock size={16} className="shrink-0 text-muted" aria-label={t('Locked')} />}
      {channel.topic && !mobile && <><span className="mx-1 h-6 w-px bg-divider" aria-hidden /><div className="min-w-0 flex-1 truncate text-sm text-muted" title={channel.topic}><Markdown content={channel.topic} guildId={channel.guildId} inline /></div></>}
      <div className="ms-auto flex items-center gap-1 md:gap-2">
        {channel.isClipsChannel && <HeaderButton label={t('Clips')} onClick={() => openModal({ kind: 'clipsViewer', channelId: channel.id })}><Film size={22} /></HeaderButton>}
        {isDm && <HeaderButton label={t('Start Voice Call')} onClick={() => void startDmCall(channel.id, false)}><Phone size={22} /></HeaderButton>}
        {isDm && <HeaderButton label={t('Start Video Call')} onClick={() => void startDmCall(channel.id, true)}><Video size={24} /></HeaderButton>}
        {isThread && (can(myChannelPerms(channel.id), Perm.MANAGE_THREADS) || channel.ownerId === me?.id) && <HeaderButton label={t('Thread Settings')} onClick={() => openModal({ kind: 'threadSettings', channelId: channel.id })}><Cog size={22} /></HeaderButton>}
        {channel.type === 'announcement' && <HeaderButton label={t('Follow Channel')} onClick={() => openModal({ kind: 'followChannel', channelId: channel.id })}><Megaphone size={22} /></HeaderButton>}
        {!isDm && !isThread && <HeaderButton label={t('Threads')} active={panel === 'threads'} onClick={() => toggle('threads')}><MessagesSquare size={24} /></HeaderButton>}
        {!mobile && <HeaderButton label={muted ? 'Unmute Channel' : 'Mute Channel'} onClick={() => setPref('mutedChannels', { ...prefs.mutedChannels, [channel.id]: !muted })}>{muted ? <BellOff size={24} /> : <Bell size={24} />}</HeaderButton>}
        <HeaderButton label={t('Pinned Messages')} active={panel === 'pins'} onClick={() => toggle('pins')}><Pin size={24} /></HeaderButton>
        {isDm && channel.type === 'dm' && !mobile && <HeaderButton label={t('Add Friends to DM')} onClick={() => openModal({ kind: 'newDm' })}><UserPlus size={24} /></HeaderButton>}
        {(!isDm || channel.type === 'group_dm') && <HeaderButton label={t('Member List')} active={mobile ? undefined : panel === 'members'} onClick={() => (mobile ? setRight(true) : toggle('members'))}><Users size={24} /></HeaderButton>}
        {!mobile && <HeaderButton label={t('Inbox')} badge={dueReminders} onClick={() => openModal({ kind: 'inbox', tab: dueReminders ? 'reminders' : undefined })}><Inbox size={24} /></HeaderButton>}
        {mobile ? <HeaderButton label={t('Search')} onClick={() => toggle('search')}><Search size={22} /></HeaderButton> : (
          <button onClick={() => toggle('search')} aria-label={t('Search')} className={cx('flex h-6 w-36 items-center justify-between rounded bg-rail px-1.5 text-start text-[13px] text-muted transition-all hover:w-44', panel === 'search' && 'w-44')}>{t('Search')}<Search size={14} /></button>
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
  const parentNsfw = useData((s) => (channel.type === 'thread' && gid && channel.parentId ? !!s.guilds[gid]?.channels[channel.parentId]?.nsfw : false));
  const ageOk = useData((s) => !!s.me?.ageConfirmed);
  const gated = !!gid && (channel.nsfw || parentNsfw) && !ageOk;

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
          {isDm && <Lazy><DmCallPanel channel={channel} /></Lazy>}
          {gated ? <AgeGate channel={channel} /> : (<>
            <MessageList key={cid} channel={channel} lastReadSnapshot={snapshot.current.v} />
            <div className="relative"><TypingIndicator channelId={cid} guildId={gid} /></div>
            <ThreadBanner channel={channel} />
            <ScreeningBanner guildId={gid} />
            {isDm && <MessageRequestBanner channel={channel} />}
            <Composer key={'c' + cid} channel={channel} stagedExternal={dropped} />
          </>)}
          {drag && (
            <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-brand/20 backdrop-blur-sm" aria-hidden>
              <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-brand bg-chat/90 px-10 py-8 text-header"><Upload size={40} className="text-brand" /><div className="text-lg font-bold">Upload to {isDm ? dmName(channel, undefined) : `#${channel.name}`}</div><div className="text-sm text-muted">{t('You can add comments before uploading.')}</div></div>
            </div>
          )}
        </div>
        {!mobile && rightPanel && <div className="hidden shrink-0 md:block">{rightPanel}</div>}
      </div>
      {overlay && <div className="absolute inset-0 z-30 animate-slideUp bg-side">{rightPanel}</div>}
      {mobile && gid && <MobileMembers open={rightDrawer} close={() => setRight(false)} guildId={gid} />}
      {mobile && !gid && channel.type === 'group_dm' && <MobileMembers open={rightDrawer} close={() => setRight(false)} dm={cid} />}
      {narrow && !mobile && panel === 'members' && (gid || channel.type === 'group_dm') && (
        <div className="absolute inset-y-0 end-0 z-30 shadow-elev">{gid ? <MemberList guildId={gid} /> : <DmMemberPanel channelId={cid} />}</div>
      )}
    </div>
  );
}

/** Archived / locked thread notice with the one action that makes sense (unarchive). */
function ThreadBanner({ channel }: { channel: Channel }) {
  const manage = can(myChannelPerms(channel.id), Perm.MANAGE_THREADS);
  if (channel.type !== 'thread' || (!channel.archived && !channel.locked)) return null;
  const unarchive = () => api.channels.patch(channel.id, { archived: false }).then((u) => useData.getState().apply('THREAD_UPDATE', { ...channel, ...u, archived: false })).catch(toastError);
  return (
    <div role="status" data-testid="thread-banner" className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-side px-3 py-2 text-sm text-muted">
      {channel.archived ? <Archive size={16} aria-hidden /> : <Lock size={16} aria-hidden />}
      <span className="min-w-0 flex-1">{channel.archived ? (channel.locked ? t('This thread is archived and locked.') : t('This thread is archived.')) : t('This thread is locked: only moderators can send messages or reopen it.')}</span>
      {channel.archived && (!channel.locked || manage) && <button className="btn btn-primary" onClick={unarchive}>{t('Unarchive')}</button>}
    </div>
  );
}

/** New members of a screened server are read-only until they accept the rules. */
/** Age-restricted channel interstitial: the person attests they are 18+ (saved on the account), or goes back. */
function AgeGate({ channel }: { channel: Channel }) {
  const nav = useNav(); const [busy, setBusy] = useState(false);
  const yes = async () => { setBusy(true); try { await api.users.confirmAge(); useData.setState((s) => ({ me: s.me ? { ...s.me, ageConfirmed: true } : s.me })); } catch (e) { toastError(e); } finally { setBusy(false); } };
  return (
    <div role="alertdialog" aria-labelledby="age-title" data-testid="age-gate" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-danger/20 text-2xl font-extrabold text-danger" aria-hidden>18+</div>
      <h2 id="age-title" className="text-xl font-bold text-header">{t('This channel is age-restricted')}</h2>
      <p className="max-w-sm text-sm text-muted">{t('#{name} may contain content that is not appropriate for everyone. Are you 18 or older?', { name: channel.name ?? '' })}</p>
      <div className="mt-2 flex gap-2">
        <button className="btn btn-secondary" onClick={() => nav.go(channel.guildId)}>{t('No, take me back')}</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => void yes()}>{t('Yes, I am 18 or older')}</button>
      </div>
    </div>
  );
}

/** A DM from someone who is not a friend: nothing is shared until the recipient accepts (replying also accepts). */
function MessageRequestBanner({ channel }: { channel: Channel }) {
  const isRequest = useData((s) => !!s.messageRequests[channel.id]); const me = useData((s) => s.me);
  const other = (channel.recipients ?? []).find((r) => r.id !== me?.id);
  const nav = useNav();
  if (!isRequest || !other) return null;
  const act = (p: Promise<unknown>, after?: () => void) => p.then(after).catch(toastError);
  return (
    <div role="region" aria-label={t('Message request')} data-testid="message-request-banner" className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md bg-brand/15 px-3 py-2 text-sm text-header">
      <span className="min-w-0 flex-1">{t('{name} is not on your friends list. Accept to move this conversation to your messages.', { name: other.displayName ?? other.username })}</span>
      <button className="btn btn-primary" onClick={() => act(api.users.acceptRequest(channel.id))}>{t('Accept')}</button>
      <button className="btn btn-secondary" onClick={() => act(api.users.ignoreRequest(channel.id), () => nav.go('@me'))}>{t('Ignore')}</button>
      <button className="btn btn-danger" onClick={() => act(api.users.setRelationship(other.id, 'blocked').then(() => api.users.ignoreRequest(channel.id)), () => nav.go('@me'))}>{t('Block')}</button>
    </div>
  );
}

function ScreeningBanner({ guildId }: { guildId: string | null }) {
  const pending = useData((s) => (guildId ? !!selfMember(s, guildId)?.pending : false)); const open = useUI((s) => s.openModal);
  if (!guildId || !pending) return null;
  return (
    <div role="status" data-testid="screening-banner" className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md bg-brand/15 px-3 py-2 text-sm text-header">
      <span className="min-w-0 flex-1">{t('Review and accept the server rules to start chatting.')}</span>
      <button className="btn btn-primary" onClick={() => open({ kind: 'screening', guildId })}>{t('Review Rules')}</button>
    </div>
  );
}

function MobileMembers({ open, close, guildId, dm }: { open: boolean; close: () => void; guildId?: string; dm?: string }) {
  return (
    <>
      <div className={cx('fixed inset-0 z-40 bg-black/60 transition-opacity', open ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={close} aria-hidden />
      <div role="dialog" aria-label={t('Members')} aria-hidden={!open} {...{ inert: open ? undefined : ('' as any) }} className={cx('drawer fixed inset-y-0 end-0 z-50 flex w-[85%] max-w-[320px] flex-col bg-side safe-top', open ? 'translate-x-0' : 'translate-x-full rtl:-translate-x-full')}>
        <div className="flex h-12 items-center justify-between px-4"><span className="font-bold text-header">{t('Members')}</span><button aria-label={t('Close members')} onClick={close} className="flex h-11 w-11 items-center justify-center"><X size={22} /></button></div>
        <div className="min-h-0 flex-1 [&>aside]:w-full">{guildId ? <MemberList guildId={guildId} /> : dm ? <DmMemberPanel channelId={dm} /> : null}</div>
      </div>
    </>
  );
}
void Hash;
