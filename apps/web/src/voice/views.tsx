import { useEffect } from 'react';
import { Menu, Mic, MicOff, Phone, PhoneOff, Radio, Signal, Video, Volume2, Headphones, VolumeX, MonitorUp, Camera, CameraOff } from 'lucide-react';
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
import { CallSurface, Lobby, StageSurface, VoiceBanners } from './Room';
import { NetBars } from './tiles';
import { getVoiceClient, joinVoice, leaveVoice } from './controller';
import { setCurrentChannel } from '@/lib/session';
import { useState } from 'react';
import { t } from '@/i18n';

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
  const conn = useVoiceUI((s) => s.conn); const cid = useVoiceUI((s) => s.connectedChannelId);
  const inHere = cid === channel.id && conn !== 'idle';
  const snap = useVoiceSnapshot();
  const mine = inHere && snap.channelId === channel.id;
  useEffect(() => { setCurrentChannel(channel.id); return () => setCurrentChannel(null); }, [channel.id]);
  const Icon = stage ? Radio : Volume2;
  const noConnect = !can(perms, Perm.CONNECT) ? 'You do not have permission to connect to this channel.' : undefined;
  return (
    <div data-testid="voice-view" data-channel={channel.id} className="relative flex h-full min-w-0 flex-1 flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content md:px-4">
        {mobile && <button aria-label={t('Open navigation')} onClick={() => setLeft(true)} className="flex h-11 w-11 items-center justify-center text-interactive"><Menu size={24} /></button>}
        <Icon size={24} className="shrink-0 text-muted" />
        <h1 className="truncate text-base font-semibold text-header">{channel.name}</h1>
        {stage && <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-mention">{t('Stage')}</span>}
        {mine && <span className="ms-auto flex items-center gap-2 text-xs text-muted"><NetBars quality={snap.networkQuality} />{snap.status === 'connected' ? 'Connected' : snap.status}</span>}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col bg-[#000]/0">
        {mine ? (
          <>
            <VoiceBanners />
            {snap.status === 'connecting' || conn === 'connecting'
              ? <div className="flex flex-1 items-center justify-center text-muted" role="status">{t('Connecting to voice…')}</div>
              : stage ? <StageSurface channelId={channel.id} /> : <CallSurface />}
            <ControlBar onSettings={() => openModal({ kind: 'voiceSettings' })} className="shrink-0 safe-bottom" />
          </>
        ) : (
          <Lobby name={channel.name ?? 'Voice'} stage={stage} users={users} busy={conn === 'connecting' && cid === channel.id} icon={<Icon size={40} />}
            disabledReason={noConnect} onJoin={() => void joinVoice(channel.id)} />
        )}
      </div>
    </div>
  );
}

/** "Voice Connected" panel above the user panel. */
export function VoiceDock() {
  const conn = useVoiceUI((s) => s.conn); const cid = useVoiceUI((s) => s.connectedChannelId);
  const ch = useData((s) => findChannel(s, cid)); const guild = useData((s) => (ch?.guildId ? s.guilds[ch.guildId]?.guild : undefined)); const me = useData((s) => s.me?.id);
  const snap = useVoiceSnapshot(); const nav = useNav(); const openModal = useUI((s) => s.openModal);
  const [pop, setPopLocal] = useState(false);
  const globalPop = useVoiceUI((s) => s.sharePop); const setGlobalPop = useVoiceUI((s) => s.setSharePop); const barMounted = useVoiceUI((s) => s.barMounted);
  const setPop = (v: boolean) => { setPopLocal(v); setGlobalPop(v); };
  if (!cid || conn === 'idle') return null;
  const isDm = ch && !ch.guildId;
  const label = conn === 'connected' ? (isDm ? 'Call Connected' : 'Voice Connected') : conn === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <div data-testid="voice-dock" className="relative border-b border-divider/70 bg-[rgb(var(--rail)/0.35)] px-2 pb-2 pt-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <button onClick={() => ch && nav.go(ch.guildId, ch.id)} className={cx('flex items-center gap-1.5 text-sm font-semibold hover:underline', conn === 'connected' ? 'text-success' : 'text-warn')}>
            <Signal size={16} />{label}
          </button>
          <div className="truncate text-xs text-muted">{ch ? (isDm ? dmName(ch, me) : `${ch.name} / ${guild?.name ?? ''}`) : ''}</div>
        </div>
        <Tip text="Disconnect" side="top"><button aria-label={t('Disconnect')} onClick={() => void leaveVoice()} className="flex h-8 w-8 items-center justify-center rounded text-interactive hover:bg-hover hover:text-interactive-hover"><PhoneOff size={20} /></button></Tip>
      </div>
      <div className="relative mt-2 grid grid-cols-3 gap-1.5">
        <button aria-label={snap.cameraOn ? 'Turn Off Camera' : 'Turn On Camera'} aria-pressed={snap.cameraOn} onClick={() => getVoiceClient().setCamera(!snap.cameraOn).catch(() => {})} className={cx('flex h-8 items-center justify-center rounded bg-[rgb(var(--active))] text-header hover:bg-[rgb(var(--divider))]', snap.cameraOn && '!bg-white !text-black')}>{snap.cameraOn ? <Camera size={18} /> : <CameraOff size={18} />}</button>
        {snap.platform.canScreenShare
          ? <button aria-label={snap.screenOn ? 'Stop Streaming' : 'Share Your Screen'} aria-pressed={snap.screenOn} onClick={() => { if (snap.screenOn) void getVoiceClient().stopScreenShare(); else setPop(true); }} className={cx('flex h-8 items-center justify-center gap-1 rounded bg-[rgb(var(--active))] text-[13px] font-semibold text-header hover:bg-[rgb(var(--divider))]', snap.screenOn && '!bg-danger !text-white')}><MonitorUp size={18} /><span className="max-sm:hidden">{snap.screenOn ? t('Live') : t('Go Live')}</span></button>
          : <span aria-hidden className="hidden" />}
        <button aria-label={t('Voice Settings')} onClick={() => openModal({ kind: 'voiceSettings' })} className="flex h-8 items-center justify-center rounded bg-[rgb(var(--active))] text-header hover:bg-[rgb(var(--divider))]"><Headphones size={18} /></button>
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
void Phone; void Video; void VolumeX;
