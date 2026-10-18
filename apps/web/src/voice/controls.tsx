import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, ChevronUp, Clapperboard, Crown, Headphones, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Settings, Activity, VolumeX } from 'lucide-react';
import { STREAM_PRESETS, type StreamPresetId } from '@jorcord/voice';
import { useVoiceClient, useVoiceSnapshot } from '@jorcord/voice/react';
import { Perm } from '@jorcord/shared';
import { Toggle } from '@/components/ui/primitives';
import { Tip } from '@/components/ui/Tooltip';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { myChannelPerms } from '@/lib/session';
import { cx } from '@/lib/format';
import { isDmChannel, leaveVoice, setPrioritySpeaker, startScreenShare } from './controller';
import { WatchTogetherPopover } from './WatchTogether';
import { t } from '@/i18n';

function RoundBtn({ label, active, danger, onClick, children, disabled, pressed, className }: { label: string; active?: boolean; danger?: boolean; onClick?: () => void; children: React.ReactNode; disabled?: boolean; pressed?: boolean; className?: string }) {
  return (
    <Tip text={label} side="top">
      <button aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
        className={cx('flex h-12 w-12 items-center justify-center rounded-full transition-colors disabled:opacity-40 max-md:h-11 max-md:w-11',
          danger ? 'bg-danger text-white hover:bg-danger-hover' : active ? 'bg-white text-black hover:bg-white/90' : 'bg-[rgb(var(--active))] text-header hover:bg-[rgb(var(--divider))]', className)}>
        {children}
      </button>
    </Tip>
  );
}

export function ScreenSharePopover({ onClose }: { onClose: () => void }) {
  const snap = useVoiceSnapshot(); const client = useVoiceClient();
  const prefs = useUI((s) => s.prefs); const setPref = useUI((s) => s.setPref);
  const live = snap.screenOn;
  const [preset, setPreset] = useState<StreamPresetId>(prefs.screenPreset as StreamPresetId);
  const [hint, setHint] = useState<'motion' | 'detail'>(prefs.screenHint);
  const [audio, setAudio] = useState(prefs.screenAudio);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  const pick = (id: StreamPresetId) => { setPreset(id); setPref('screenPreset', id as any); if (live) void client.setLiveStreamQuality(id, hint); };
  return (
    <div ref={ref} role="dialog" aria-label={t('Screen share quality')} data-testid="share-popover"
      className="fixed inset-x-3 bottom-[88px] z-50 animate-pop rounded-lg bg-float p-3 text-start shadow-elev md:absolute md:inset-x-auto md:bottom-full md:end-0 md:mb-3 md:w-80">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-interactive">{t('Stream quality')}</div>
      <div role="radiogroup" aria-label={t('Resolution and frame rate')} className="grid gap-1">
        {STREAM_PRESETS.map((p) => (
          <label key={p.id} className={cx('flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-hover', preset === p.id && 'bg-hover')}>
            <input type="radio" name="sharepreset" className="accent-brand" checked={preset === p.id} onChange={() => pick(p.id)} aria-label={p.id === 'source' ? 'Source' : p.label} />
            <span className="flex-1 text-sm font-medium text-header">{p.id === 'source' ? 'Source' : p.label.replace(' ', ' · ')}</span>
            <span className="text-xs text-muted">{p.id === 'source' ? `up to ${p.width}x${p.height}@${p.fps}` : `${p.width}x${p.height}`}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-sm text-header">
        <label htmlFor="sharehint">{t('Optimise for')}</label>
        <select id="sharehint" className="field !min-h-0 !w-auto py-1" value={hint} onChange={(e) => { const v = e.target.value as 'motion' | 'detail'; setHint(v); setPref('screenHint', v); if (live) client.setContentHint(v); }}>
          <option value="motion">Motion (games, video)</option><option value="detail">Detail (text, slides)</option>
        </select>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-header"><span>{t('Share audio')}</span><Toggle label={t('Share audio')} checked={audio} onChange={(v) => { setAudio(v); setPref('screenAudio', v); }} /></div>
      {!live
        ? <button className="btn btn-primary btn-lg mt-3 w-full" onClick={() => { onClose(); void startScreenShare({ preset, hint, audio }); }}>{t('Go Live')}</button>
        : <button className="btn btn-danger btn-lg mt-3 w-full" onClick={() => { onClose(); void client.stopScreenShare(); }}>{t('Stop Streaming')}</button>}
    </div>
  );
}

export function ControlBar({ onSettings, className }: { onSettings: () => void; className?: string }) {
  const snap = useVoiceSnapshot(); const client = useVoiceClient();
  const selfMute = useVoiceUI((s) => s.selfMute); const selfDeaf = useVoiceUI((s) => s.selfDeaf); const toggleMute = useVoiceUI((s) => s.toggleMute); const toggleDeaf = useVoiceUI((s) => s.toggleDeaf);
  const showStats = useUI((s) => s.prefs.showVoiceStats); const setPref = useUI((s) => s.setPref);
  const [pop, setPopLocal] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const globalPop = useVoiceUI((s) => s.sharePop); const setGlobalPop = useVoiceUI((s) => s.setSharePop); const setBarMounted = useVoiceUI((s) => s.setBarMounted);
  useEffect(() => { setBarMounted(true); return () => setBarMounted(false); }, [setBarMounted]);
  const setPop = (v: boolean | ((x: boolean) => boolean)) => { const n = typeof v === 'function' ? v(pop || globalPop) : v; setPopLocal(n); setGlobalPop(n); };
  const popOpen = pop || globalPop;
  const stage = false;
  const canShare = snap.platform.canScreenShare;
  const canPublish = snap.participants.find((p) => p.isLocal)?.canPublish !== false;
  const muted = selfMute || selfDeaf;
  const channelId = useVoiceUI((s) => s.connectedChannelId);
  const priority = !!snap.participants.find((p) => p.isLocal)?.priority;
  const canPriority = snap.status === 'connected' && !!channelId && !isDmChannel(channelId) && (myChannelPerms(channelId) & Perm.PRIORITY_SPEAKER) !== 0n;
  void stage;
  return (
    <div className={cx('relative flex flex-wrap items-center justify-center gap-3 px-3 py-3 max-md:gap-2 max-md:pb-5', className)} role="toolbar" aria-label={t('Voice controls')}>
      <RoundBtn label={snap.cameraOn ? 'Turn Off Camera' : 'Turn On Camera'} active={snap.cameraOn} pressed={snap.cameraOn} disabled={!canPublish}
        onClick={() => void client.setCamera(!snap.cameraOn).catch(() => {})}>{snap.cameraOn ? <Camera size={22} /> : <CameraOff size={22} />}</RoundBtn>
      {canShare && (
        <div className="relative flex items-center">
          <RoundBtn label={snap.screenOn ? 'Stop Streaming' : 'Share Your Screen'} active={snap.screenOn} pressed={snap.screenOn} disabled={!canPublish}
            onClick={() => { if (snap.screenOn) void client.stopScreenShare(); else setPop(true); }}>{snap.screenOn ? <MonitorX size={22} /> : <MonitorUp size={22} />}</RoundBtn>
          <button aria-label={t('Stream quality options')} aria-expanded={popOpen} onClick={() => setPop((v) => !v)} disabled={!canPublish} className="-ms-2 flex h-6 w-6 items-center justify-center rounded-full bg-[rgb(var(--divider))] text-header hover:bg-brand disabled:opacity-40"><ChevronUp size={14} /></button>
          {popOpen && <ScreenSharePopover onClose={() => setPop(false)} />}
        </div>
      )}
      <RoundBtn label={muted ? 'Unmute' : 'Mute'} pressed={muted} active={false} className={muted ? '!bg-danger/20 !text-danger' : ''} onClick={toggleMute} disabled={!canPublish && !muted}>{muted ? <MicOff size={22} /> : <Mic size={22} />}</RoundBtn>
      <RoundBtn label={selfDeaf ? 'Undeafen' : 'Deafen'} pressed={selfDeaf} className={selfDeaf ? '!bg-danger/20 !text-danger' : ''} onClick={toggleDeaf}>{selfDeaf ? <VolumeX size={22} /> : <Headphones size={22} />}</RoundBtn>
      {canPriority && (
        <RoundBtn label={priority ? 'Disable Priority Speaker' : 'Enable Priority Speaker'} active={priority} pressed={priority} onClick={() => setPrioritySpeaker(!priority)}><Crown size={22} /></RoundBtn>
      )}
      {channelId && snap.status === 'connected' && (
        <div className="relative flex items-center" data-watch-together-toggle>
          <RoundBtn label={t('Activities')} active={activitiesOpen} pressed={activitiesOpen} onClick={() => setActivitiesOpen((v) => !v)}><Clapperboard size={22} /></RoundBtn>
          {activitiesOpen && <WatchTogetherPopover channelId={channelId} onClose={() => setActivitiesOpen(false)} />}
        </div>
      )}
      <RoundBtn label={t('Voice Settings')} onClick={onSettings}><Settings size={22} /></RoundBtn>
      <RoundBtn label={showStats ? 'Hide Connection Stats' : 'Show Connection Stats'} pressed={showStats} active={showStats} onClick={() => setPref('showVoiceStats', !showStats)} ><Activity size={22} /></RoundBtn>
      <RoundBtn label={t('Disconnect')} danger onClick={() => void leaveVoice()}><PhoneOff size={22} /></RoundBtn>
    </div>
  );
}
