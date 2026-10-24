import { useEffect, useRef, useState } from 'react';
import { Maximize2, MicOff, VolumeX, Monitor, Eye, EyeOff, Activity, Hand, Crown } from 'lucide-react';
import { useStreamStats, useVideoTrack, useVoiceClient, useVoiceSnapshot } from '@jorcord/voice/react';
import { formatKbps, type ParticipantView, type ViewerQuality } from '@jorcord/voice';
import { Avatar } from '@/components/ui/Avatar';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { voiceUserMenu } from './menu';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { useVoiceUI } from '@/stores/voiceui';
import { SelfViewPainter, effectsEnabled, isCanvasFilterSupported } from './cameraEffects';
import { cx } from '@/lib/format';
import { StreamAudience, useStreamGate } from './StreamAudience';
import { TileEffects } from './TileEffects';

export function useVoiceUser(identity: string) {
  return useData((s) => s.users[identity]);
}

/**
 * Local camera element for the self-view. Mirrors per preference and, when the opt-in canvas effects are
 * enabled and supported, paints through an overlay canvas. The <video> stays mounted either way so the
 * LiveKit track keeps its attachment.
 */
export function SelfViewVideo({ videoRef, className, style, label, testId }: { videoRef: React.MutableRefObject<HTMLVideoElement | null>; className?: string; style?: React.CSSProperties; label?: string; testId?: string }) {
  const mirror = useUI((s) => s.prefs.mirrorSelfView);
  const blur = useUI((s) => s.prefs.cameraBlur);
  const autoAdjust = useUI((s) => s.prefs.cameraAutoAdjust);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [painting, setPainting] = useState(false);
  useEffect(() => {
    const video = videoRef.current; const el = canvas.current;
    if (!video || !el || !effectsEnabled({ blur, autoAdjust }) || !isCanvasFilterSupported()) { setPainting(false); return; }
    setPainting(true);
    const painter = new SelfViewPainter({ video, canvas: el, effects: () => ({ blur, autoAdjust }) });
    return painter.start();
  }, [videoRef, blur, autoAdjust]);
  const transform = mirror ? 'scaleX(-1)' : undefined;
  return (
    <>
      <video ref={videoRef} autoPlay playsInline muted aria-label={label} data-testid={testId} className={cx(className, painting && 'invisible')} style={{ ...style, transform }} />
      <canvas ref={canvas} aria-hidden className={cx(className, 'pointer-events-none absolute inset-0', !painting && 'hidden')} style={{ transform }} />
    </>
  );
}

export function NetBars({ quality, className }: { quality: string; className?: string }) {
  const n = ({ excellent: 3, good: 2, poor: 1, lost: 0, unknown: 3 } as Record<string, number>)[quality] ?? 0;
  const color = quality === 'poor' ? 'bg-warn' : quality === 'lost' ? 'bg-danger' : 'bg-success';
  return (
    <span className={cx('inline-flex h-3 items-end gap-[2px]', className)} role="img" aria-label={`Connection ${quality}`}>
      {[1, 2, 3].map((i) => <i key={i} className={cx('block w-[3px] rounded-[1px]', i <= n ? color : 'bg-[rgb(var(--active))]')} style={{ height: 4 + i * 3 }} />)}
    </span>
  );
}

export function StatsPanel({ identity, source, className, sent }: { identity: string; source: 'camera' | 'screen'; className?: string; sent?: boolean }) {
  const st = useStreamStats(identity, source, true);
  const rows: [string, string][] = st
    ? [[sent ? 'Sent resolution' : 'Resolution', `${st.width}x${st.height}`], [sent ? 'Sent frame rate' : 'Frame rate', `${st.fps} fps`], ['Bitrate', formatKbps(st.bitrateKbps)], ['Codec', st.codec || '-'], ['RTT', st.rttMs == null ? '-' : `${st.rttMs} ms`], ...(st.qualityLimitation ? [['Limited by', st.qualityLimitation] as [string, string]] : []), ...(st.layer ? [['Layer', st.layer] as [string, string]] : [])]
    : [['Stats', 'waiting for data']];
  return (
    <dl data-testid="stream-stats" data-width={st?.width ?? 0} data-height={st?.height ?? 0} data-fps={st?.fps ?? 0} data-sent={sent ? 'true' : undefined} aria-label="Stream statistics"
      className={cx('pointer-events-none absolute end-2 top-2 z-10 m-0 grid min-w-[150px] gap-0.5 rounded-md bg-black/75 p-2 font-mono text-[11px] leading-4 text-white backdrop-blur', className)}>
      {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-white/60">{k}</dt><dd className="m-0">{v}</dd></div>)}
    </dl>
  );
}

function NamePill({ p, extra }: { p: ParticipantView; extra?: React.ReactNode }) {
  const vs = useData((s) => s.voiceStates[p.identity]);
  const deaf = vs?.selfDeaf || vs?.serverDeaf; const muted = p.micMuted || !!vs?.serverMute;
  return (
    <span className="pointer-events-none absolute bottom-2 start-2 z-[5] flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded bg-black/65 px-2 py-0.5 text-[13px] font-semibold text-white">
      {deaf ? <VolumeX size={14} className="shrink-0 text-danger" aria-label="Deafened" /> : muted ? <MicOff size={14} className="shrink-0 text-danger" aria-label="Muted" /> : null}
      <span className="truncate">{p.name}{p.isLocal ? ' (you)' : ''}</span>{extra}
    </span>
  );
}

/** Avatar (or camera) tile for a participant. */
export function ParticipantTile({ p, size = 'lg', focused, onClick, showStats }: { p: ParticipantView; size?: 'lg' | 'sm'; focused?: boolean; onClick?: () => void; showStats?: boolean }) {
  const user = useVoiceUser(p.identity);
  const { ref, present } = useVideoTrack(p.identity, 'camera');
  const sm = size === 'sm';
  const cid = useVoiceUI((st) => st.connectedChannelId);
  const trig = useMenuTrigger(() => voiceUserMenu(p.identity, cid ?? ''));
  return (
    <div {...trig} data-tile={`${p.identity}:camera`} data-speaking={p.speaking} data-muted={p.micMuted} data-testid="voice-tile" role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onClick={onClick} onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      aria-label={`${p.name}${p.speaking ? ', speaking' : ''}${p.micMuted ? ', muted' : ''}`}
      className={cx('group relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-[#1e1f22] transition-shadow duration-100', onClick && 'cursor-pointer', p.speaking ? 'shadow-[inset_0_0_0_3px_rgb(var(--success))]' : focused ? 'shadow-[inset_0_0_0_2px_rgb(var(--brand))]' : '', sm ? 'aspect-video h-full shrink-0' : 'h-full w-full')}>
      {present
        ? (p.isLocal
            ? <SelfViewVideo videoRef={ref} className="h-full w-full object-cover" />
            : <video ref={ref} autoPlay playsInline muted className="h-full w-full object-cover" />)
        : <div className="flex h-full w-full items-center justify-center">
            <span className={cx('rounded-full transition-shadow duration-100', p.speaking && 'shadow-[0_0_0_4px_rgb(var(--success))]')} style={{ lineHeight: 0 }}>
              <Avatar user={user ?? { id: p.identity, username: p.name, displayName: p.name, avatar: null }} size={sm ? 44 : 88} />
            </span>
          </div>}
      <TileEffects userId={p.identity} />
      <NamePill p={p} extra={p.handRaised ? <Hand size={13} className="text-warn" aria-label="Hand raised" /> : null} />
      {p.priority && <Crown size={14} aria-label="Priority speaker" role="img" data-testid="priority-badge" className="absolute start-2 top-2 z-[5] text-warn" />}
      <span data-testid="tile-netbars" className={cx('pointer-events-none absolute end-2 top-2 z-[5] transition-opacity', showStats ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}><NetBars quality={p.quality} /></span>
      {showStats && present && <StatsPanel identity={p.identity} source="camera" sent={p.isLocal} />}
    </div>
  );
}

const VQ: { id: ViewerQuality; label: string }[] = [{ id: 'auto', label: 'Auto' }, { id: 'low', label: '360p' }, { id: 'medium', label: '720p' }, { id: 'high', label: 'Source' }];

/** A screen-share stream tile. */
export function ScreenTile({ p, size = 'lg', focused, onClick }: { p: ParticipantView; size?: 'lg' | 'sm'; focused?: boolean; onClick?: () => void }) {
  const client = useVoiceClient();
  const snap = useVoiceSnapshot();
  const { ref, present } = useVideoTrack(p.identity, 'screen');
  const stats = useUI((s) => s.prefs.showVoiceStats); const setPref = useUI((s) => s.setPref);
  const [watching, setWatching] = useState(true);
  const [q, setQ] = useState<ViewerQuality>('auto');
  // the server counts me as a viewer and may turn me away (stream full / removed by the streamer)
  const channelId = useVoiceUI((st) => st.connectedChannelId);
  const { gate, limit, retry } = useStreamGate(channelId, p.identity, !p.isLocal && watching && p.screenOn);
  const refused = !p.isLocal && (gate === 'full' || gate === 'kicked');
  const box = useRef<HTMLDivElement>(null);
  const sm = size === 'sm';
  useEffect(() => { if (!p.isLocal) client.setViewerQuality(p.identity, 'screen', q); }, [client, p.identity, p.isLocal, q, p.screenOn]);
  useEffect(() => {
    if (p.isLocal) return;
    if (refused) client.setWatching(p.identity, 'screen', false);
    else if (gate === 'ok' && watching) client.setWatching(p.identity, 'screen', true);
  }, [client, p.identity, p.isLocal, refused, gate, watching]);
  const label = p.isLocal ? 'Your screen' : `${p.name}'s screen`;
  void snap;
  return (
    <div ref={box} data-tile={`${p.identity}:screen`} data-testid="screen-tile" role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick}
      aria-label={label}
      className={cx('group relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-black', onClick && 'cursor-pointer', focused && !sm && 'shadow-[inset_0_0_0_2px_rgb(var(--brand))]', sm ? 'aspect-video h-full shrink-0' : 'h-full w-full')}>
      {present && watching && !refused
        ? <video ref={ref} autoPlay playsInline muted className="h-full w-full object-contain" />
        : <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#1e1f22] px-3 text-center text-muted">
            <Monitor size={sm ? 24 : 48} />
            {refused && !sm && (gate === 'full'
              ? <><span role="status" data-testid="stream-full" className="text-sm">{limit ? `This stream is full (limit ${limit}).` : 'This stream is full.'}</span><button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); retry(); }}>Try again</button></>
              : <span role="status" data-testid="stream-kicked" className="text-sm">The streamer removed you from this stream.</span>)}
            {!sm && !refused && (watching ? <span className="text-sm">Loading stream…</span> :
              <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); setWatching(true); client.setWatching(p.identity, 'screen', true); }}><Eye size={16} />Watch Stream</button>)}
          </div>}
      <span className="pointer-events-none absolute start-2 top-2 z-[5] flex items-center gap-1.5">
        <span className="rounded bg-danger px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">Live</span>
        {!sm && <span className="rounded bg-black/65 px-2 py-0.5 text-[13px] font-semibold text-white">{label}</span>}
      </span>
      {!sm && channelId && <div className="absolute start-2 top-9 z-[7]"><StreamAudience streamerId={p.identity} /></div>}
      {sm && <span className="pointer-events-none absolute bottom-1 start-1 z-[5] max-w-[90%] truncate rounded bg-black/65 px-1.5 text-xs font-semibold text-white">{label}</span>}
      {!sm && (
        <div className="absolute inset-x-0 bottom-0 z-[6] flex flex-wrap items-center justify-end gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100" onClick={(e) => e.stopPropagation()}>
          {!p.isLocal && (
            <label className="flex items-center gap-1 text-xs text-white/80">Quality
              <select aria-label="Viewing quality" value={q} onChange={(e) => setQ(e.target.value as ViewerQuality)} className="rounded bg-black/60 px-1 py-0.5 text-xs text-white">
                {VQ.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          )}
          <button aria-label="Stream stats" aria-pressed={stats} onClick={() => setPref('showVoiceStats', !stats)} className={cx('flex h-8 w-8 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80', stats && 'bg-brand')}><Activity size={16} /></button>
          {!p.isLocal && watching && <button aria-label="Stop watching" onClick={() => { setWatching(false); client.setWatching(p.identity, 'screen', false); }} className="flex h-8 w-8 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"><EyeOff size={16} /></button>}
          <button aria-label="Fullscreen" onClick={() => { const el = box.current; if (document.fullscreenElement) void document.exitFullscreen(); else void el?.requestFullscreen?.(); }} className="flex h-8 w-8 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"><Maximize2 size={16} /></button>
        </div>
      )}
      {stats && !sm && present && <StatsPanel identity={p.identity} source="screen" />}
    </div>
  );
}
