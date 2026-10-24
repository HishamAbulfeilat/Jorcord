import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { MessageSquare, Menu, Mic, MicOff, Phone, PhoneOff, Radio, Signal, Video, Volume2, Headphones, VolumeX, MonitorUp, MonitorX, Settings, Camera, CameraOff } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { useData, findChannel } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { useGuildPerms } from '@/lib/useGuild';
import { can } from '@/lib/perms';
import { useIsMobile } from '@/lib/hooks';
import { useNav } from '@/lib/nav';
import { cx, dmName } from '@/lib/format';
import { Tip } from '@/components/ui/Tooltip';
import { useShallow } from 'zustand/react/shallow';
import { ControlBar, ScreenSharePopover } from './controls';
import { ConnectionPopover, DiagnosticsPanel, useConnectingElapsed } from './Troubleshoot';
import { CallSurface, Lobby, StageSurface, VoiceBanners } from './Room';
import { TicTacToeView } from './TicTacToe';
import { AppActivityView } from './AppActivity';
import { NetBars } from './tiles';
import { getVoiceClient, joinVoice, leaveVoice } from './controller';
import { setCurrentChannel } from '@/lib/session';
import { useState } from 'react';
import { SoundboardButton } from '@/components/Soundboard';
import { t } from '@/i18n';
import { StageBar, canModerateStage } from './StageBar';
import { VoiceStatusEditor, VoiceStatusText } from './VoiceStatus';
import { VoiceChatPanel } from '@/components/chat/VoiceChat';
import { channelUnread } from '@/stores/data';

export function useChannelVoiceUsers(channelId: string) {
  return useData(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channelId).map((v) => s.users[v.userId] ?? { id: v.userId, username: 'user', displayName: 'user', avatar: null })));
}

/** True when the local client is joined to (or joining) this channel. */
export function useInChannel(channelId: string) {
  const conn = useVoiceUI((s) => s.conn); const cid = useVoiceUI((s) => s.connectedChannelId);
  return cid === channelId && conn !== 'idle';
}

export function VoiceChannelView({ channel }: { channel: Channel }) {
  const stage = channel.type === 'stage';
  const mobile = useIsMobile(); const setLeft = useUI((s) => s.setLeftDrawer); const openModal = useUI((s) => s.openModal);
  const perms = useGuildPerms(channel.guildId ?? undefined, channel);
  const users = useChannelVoiceUsers(channel.id);
  const conn = useVoiceUI((s) => s.conn); const cid = useVoiceUI((s) => s.connectedChannelId); const failure = useVoiceUI((s) => s.failure);
  const inHere = cid === channel.id && conn !== 'idle';
  const snap = useVoiceSnapshot();
  const mine = inHere && snap.channelId === channel.id;
  useEffect(() => { setCurrentChannel(channel.id); return () => setCurrentChannel(null); }, [channel.id]);
  const Icon = stage ? Radio : Volume2;
  const [chat, setChat] = useState(false);
  const unread = useData(useShallow((s) => channelUnread(s, channel)));
  const noConnect = !can(perms, Perm.CONNECT) ? 'You do not have permission to connect to this channel.' : undefined;
  return (
    <div data-testid="voice-view" data-channel={channel.id} className="relative flex h-full min-w-0 flex-1 flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content md:px-4">
        {mobile && <button aria-label={t('Open navigation')} onClick={() => setLeft(true)} className="flex h-11 w-11 items-center justify-center text-interactive"><Menu size={24} /></button>}
        <Icon size={24} className="shrink-0 text-muted" />
        <h1 className="truncate text-base font-semibold text-header">{channel.name}</h1>
        {channel.voiceStatus && <VoiceStatusText status={channel.voiceStatus} className="hidden min-w-0 max-w-[40%] truncate border-s border-divider ps-2 text-sm text-muted sm:inline" />}
        {stage && <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-mention">{t('Stage')}</span>}
        <span className="ms-auto flex items-center gap-2 text-xs text-muted">
          {mine && <><NetBars quality={snap.networkQuality} />{snap.status === 'connected' ? 'Connected' : snap.status}</>}
          <Tip text={chat ? t('Hide Chat') : t('Show Chat')} side="bottom"><button aria-label={chat ? t('Hide Chat') : t('Show Chat')} aria-pressed={chat} onClick={() => setChat((v) => !v)} className={cx('relative flex h-8 w-8 items-center justify-center rounded', chat ? 'text-header' : 'text-interactive hover:text-interactive-hover')}><MessageSquare size={22} />{unread.mentions > 0 ? <span className="absolute end-0.5 top-0 h-2 w-2 rounded-full bg-danger" /> : unread.unread && !chat ? <span className="absolute end-1 top-1 h-2 w-2 rounded-full bg-header" /> : null}</button></Tip>
        </span>
      </header>
      {stage && <StageBar channel={channel} />}
      <div className="relative flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#000]/0">
        {mine ? (
          <>
            <VoiceBanners />
            {snap.status === 'connecting' || conn === 'connecting'
              ? <ConnectingView />
              : stage ? <StageSurface channelId={channel.id} /> : <CallSurface />}
            {!stage && <TicTacToeView channelId={channel.id} />}
            {!stage && <AppActivityView channelId={channel.id} />}
            <ControlBar onSettings={() => openModal({ kind: 'voiceSettings' })} className="shrink-0 safe-bottom" />
          </>
        ) : (
          <Lobby name={channel.name ?? 'Voice'} stage={stage} users={users} busy={conn === 'connecting' && cid === channel.id} icon={<Icon size={40} />}
            failure={failure?.channelId === channel.id ? failure : null} disabledReason={noConnect} onJoin={() => void joinVoice(channel.id)} />
        )}
      </div>
      {chat && <VoiceChatPanel channel={channel} onClose={() => setChat(false)} />}
      </div>
    </div>
  );
}

/** Join in progress: elapsed time, Cancel, and a nudge after a few seconds so it never looks hung. */
function ConnectingView() {
  const secs = useConnectingElapsed();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted" role="status" data-testid="voice-connecting">
      <Loader2 size={28} className="animate-spin" />
      <div>{t('Connecting to voice…')}</div>
      {secs >= 5 && <div className="max-w-sm text-xs">{t('This is taking longer than usual. It will stop with the reason after 15 seconds.')}</div>}
      <button className="btn btn-secondary" onClick={() => void leaveVoice()}>{t('Cancel')}</button>
    </div>
  );
}

/** Shared look of the icon-only buttons in the Voice Connected panel (camera, Go Live, soundboard, settings). */
export const DOCK_BTN = 'flex h-8 w-full items-center justify-center rounded bg-[rgb(var(--active))] text-header hover:bg-[rgb(var(--divider))]';

/** "Voice Connected" panel above the user panel. */
export function VoiceDock() {
  const conn = useVoiceUI((s) => s.conn); const cid = useVoiceUI((s) => s.connectedChannelId);
  const ch = useData((s) => findChannel(s, cid)); const guild = useData((s) => (ch?.guildId ? s.guilds[ch.guildId]?.guild : undefined)); const me = useData((s) => s.me?.id);
  const snap = useVoiceSnapshot(); const nav = useNav(); const openModal = useUI((s) => s.openModal); const showStats = useUI((s) => s.prefs.showVoiceStats);
  const [pop, setPopLocal] = useState(false); const [details, setDetails] = useState(false); const [diag, setDiag] = useState(false);
  const globalPop = useVoiceUI((s) => s.sharePop); const setGlobalPop = useVoiceUI((s) => s.setSharePop); const barMounted = useVoiceUI((s) => s.barMounted);
  const setPop = (v: boolean) => { setPopLocal(v); setGlobalPop(v); };
  if (!cid || conn === 'idle') return null;
  const isDm = ch && !ch.guildId;
  const label = conn === 'connected' ? (isDm ? 'Call Connected' : 'Voice Connected') : conn === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <div data-testid="voice-dock" className="relative border-b border-divider/70 bg-[rgb(var(--rail)/0.35)] px-2 pb-2 pt-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <button aria-label={`${label}: ${t('Connection details')}`} aria-expanded={details} onClick={() => setDetails((v) => !v)} className={cx('flex items-center gap-1.5 text-sm font-semibold hover:underline', conn === 'connected' ? 'text-success' : 'text-warn')}>
            {conn === 'connected' ? <Signal size={16} /> : <Loader2 size={16} className="animate-spin" />}{label}
            {conn === 'reconnecting' && snap.reconnect.attempt > 0 && <span className="text-[11px] font-medium">({snap.reconnect.attempt}/{snap.reconnect.maxAttempts})</span>}
          </button>
          <div className="truncate text-xs text-muted">{ch ? (isDm ? dmName(ch, me) : `${ch.name} / ${guild?.name ?? ''}`) : ''}</div>
          {ch?.guildId && conn === 'connected' && <VoiceStatusEditor channelId={ch.id} />}
        </div>
        <Tip text="Disconnect" side="top"><button aria-label={t('Disconnect')} onClick={() => void leaveVoice()} className="flex h-8 w-8 items-center justify-center rounded text-interactive hover:bg-hover hover:text-interactive-hover"><PhoneOff size={20} /></button></Tip>
      </div>
      {conn === 'connected' && showStats && snap.connection?.rttMs != null && <div data-testid="voice-dock-ping" className="mt-0.5 text-[11px] text-muted">{snap.connection.rttMs} ms{snap.connection.packetLossPct ? ` · ${snap.connection.packetLossPct}% ${t('loss')}` : ''}</div>}
      {details && !diag && <ConnectionPopover onClose={() => setDetails(false)} onDisconnect={() => { setDetails(false); void leaveVoice(); }} onDiagnostics={() => { setDetails(false); setDiag(true); }} />}
      {diag && <DiagnosticsPanel onClose={() => setDiag(false)} />}
      <div className="relative mt-2 grid grid-cols-4 gap-1.5">
        <Tip text={snap.cameraOn ? t('Turn Off Camera') : t('Turn On Camera')} side="top"><button data-testid="dock-camera" aria-label={snap.cameraOn ? 'Turn Off Camera' : 'Turn On Camera'} aria-pressed={snap.cameraOn} onClick={() => getVoiceClient().setCamera(!snap.cameraOn).catch(() => {})} className={cx(DOCK_BTN, snap.cameraOn && '!bg-white !text-black')}>{snap.cameraOn ? <Camera size={18} /> : <CameraOff size={18} />}</button></Tip>
        {snap.platform.canScreenShare
          ? <Tip text={snap.screenOn ? t('Stop Streaming') : t('Go Live')} side="top"><button data-testid="dock-golive" aria-label={snap.screenOn ? 'Stop Streaming' : 'Share Your Screen'} aria-pressed={snap.screenOn} onClick={() => { if (snap.screenOn) void getVoiceClient().stopScreenShare(); else setPop(true); }} className={cx(DOCK_BTN, snap.screenOn && '!bg-danger !text-white')}>{snap.screenOn ? <MonitorX size={18} /> : <MonitorUp size={18} />}</button></Tip>
          : <span aria-hidden className="hidden" />}
        {ch?.guildId && conn === 'connected' && <SoundboardButton channelId={ch.id} guildId={ch.guildId} />}
        <Tip text={t('Voice Settings')} side="top"><button data-testid="dock-settings" aria-label={t('Voice Settings')} onClick={() => openModal({ kind: 'voiceSettings' })} className={DOCK_BTN}><Settings size={18} /></button></Tip>
        {(pop || globalPop) && !barMounted && <ScreenSharePopover onClose={() => setPop(false)} />}
      </div>
    </div>
  );
}

/** Mobile-only strip shown while in a call and viewing something other than the call itself. */
export function MobileVoiceBar() {
  const mobile = useIsMobile();
  const conn = useVoiceUI((s) => s.conn); const cid = useVoiceUI((s) => s.connectedChannelId);
  const ch = useData((s) => findChannel(s, cid)); const nav = useNav(); const me = useData((s) => s.me?.id);
  const muted = useVoiceUI((s) => s.selfMute || s.selfDeaf); const toggleMute = useVoiceUI((s) => s.toggleMute);
  const { channelId } = useRouteChannel();
  if (!mobile || !cid || conn === 'idle' || !ch || channelId === cid) return null;
  return (
    <div data-testid="mobile-voice-bar" className="flex shrink-0 items-center gap-2 bg-success/20 px-3 py-1.5 text-sm">
      <button className="flex min-w-0 flex-1 items-center gap-2 text-start font-semibold text-success" onClick={() => nav.go(ch.guildId, ch.id)}><Signal size={16} /><span className="truncate">{ch.guildId ? ch.name : dmName(ch, me)}</span></button>
      <button aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} className="flex h-9 w-9 items-center justify-center rounded text-header">{muted ? <MicOff size={18} className="text-danger" /> : <Mic size={18} />}</button>
      <button aria-label={t('Disconnect')} onClick={() => void leaveVoice()} className="flex h-9 w-9 items-center justify-center rounded text-danger"><PhoneOff size={18} /></button>
    </div>
  );
}
import { useRouteIds } from '@/lib/nav';
function useRouteChannel() { return useRouteIds(); }
void Phone; void Video; void VolumeX; void canModerateStage;
