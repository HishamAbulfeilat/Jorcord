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
import { cx } from '@/lib/format';

export function useVoiceUser(identity: string) {
  return useData((s) => s.users[identity]);
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

export function StatsPanel({ identity, source, className }: { identity: string; source: 'camera' | 'screen'; className?: string }) {
  const st = useStreamStats(identity, source, true);
  const rows: [string, string][] = st
    ? [['Resolution', `${st.width}x${st.height}`], ['Frame rate', `${st.fps} fps`], ['Bitrate', formatKbps(st.bitrateKbps)], ['Codec', st.codec || '-'], ['RTT', st.rttMs == null ? '-' : `${st.rttMs} ms`], ...(st.qualityLimitation ? [['Limited by', st.qualityLimitation] as [string, string]] : []), ...(st.layer ? [['Layer', st.layer] as [string, string]] : [])]
    : [['Stats', 'waiting for data']];
  return (
    <dl data-testid="stream-stats" data-width={st?.width ?? 0} data-height={st?.height ?? 0} data-fps={st?.fps ?? 0} aria-label="Stream statistics"
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
        ? <video ref={ref} autoPlay playsInline muted className="h-full w-full object-cover" style={{ transform: p.isLocal ? 'scaleX(-1)' : undefined }} />
        : <div className="flex h-full w-full items-center justify-center">
            <span className={cx('rounded-full transition-shadow duration-100', p.speaking && 'shadow-[0_0_0_4px_rgb(var(--success))]')} style={{ lineHeight: 0 }}>
              <Avatar user={user ?? { id: p.identity, username: p.name, displayName: p.name, avatar: null }} size={sm ? 44 : 88} />
            </span>
          </div>}
      <NamePill p={p} extra={p.handRaised ? <Hand size={13} className="text-warn" aria-label="Hand raised" /> : null} />
      {p.priority && <Crown size={14} className="absolute end-2 top-2 text-warn" />}
      <span className="pointer-events-none absolute end-2 top-2 z-[5] opacity-0 transition-opacity group-hover:opacity-100"><NetBars quality={p.quality} /></span>
      {showStats && present && <StatsPanel identity={p.identity} source="camera" />}
    </div>
  );
}

const VQ: { id: ViewerQuality; label: string }[] = [{ id: 'auto', label: 'Auto' }, { id: 'low', label: '360p' }, { id: 'medium', label: '720p' }, { id: 'high', label: 'Source' }];

/** A screen-share stream tile. */
export function ScreenTile({ p, size = 'lg', focused, onClick }: { p: ParticipantView; size?: 'lg' | 'sm'; focused?: boolean; onClick?: () => void }) {
  const client = useVoiceClient();
  const snap = useVoiceSnapshot();
  const { ref, present } = useVideoTrack(p.identity, 'screen');
  const [stats, setStats] = useState(() => useUI.getState().prefs.showVoiceStats);
  const [watching, setWatching] = useState(true);
  const [q, setQ] = useState<ViewerQuality>('auto');
  const box = useRef<HTMLDivElement>(null);
  const sm = size === 'sm';
  useEffect(() => { if (!p.isLocal) client.setViewerQuality(p.identity, 'screen', q); }, [client, p.identity, p.isLocal, q, p.screenOn]);
  const label = p.isLocal ? 'Your screen' : `${p.name}'s screen`;
  void snap;
  return (
    <div ref={box} data-tile={`${p.identity}:screen`} data-testid="screen-tile" role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick}
      aria-label={label}
      className={cx('group relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-black', onClick && 'cursor-pointer', focused && !sm && 'shadow-[inset_0_0_0_2px_rgb(var(--brand))]', sm ? 'aspect-video h-full shrink-0' : 'h-full w-full')}>
      {present && watching
        ? <video ref={ref} autoPlay playsInline muted className="h-full w-full object-contain" />
        : <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#1e1f22] text-muted">
            <Monitor size={sm ? 24 : 48} />
            {!sm && (watching ? <span className="text-sm">Loading stream…</span> :
              <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); setWatching(true); client.setWatching(p.identity, 'screen', true); }}><Eye size={16} />Watch Stream</button>)}
          </div>}
      <span className="pointer-events-none absolute start-2 top-2 z-[5] flex items-center gap-1.5">
        <span className="rounded bg-danger px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">Live</span>
        {!sm && <span className="rounded bg-black/65 px-2 py-0.5 text-[13px] font-semibold text-white">{label}</span>}
      </span>
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
          <button aria-label="Stream stats" aria-pressed={stats} onClick={() => setStats((s) => !s)} className={cx('flex h-8 w-8 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80', stats && 'bg-brand')}><Activity size={16} /></button>
          {!p.isLocal && watching && <button aria-label="Stop watching" onClick={() => { setWatching(false); client.setWatching(p.identity, 'screen', false); }} className="flex h-8 w-8 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"><EyeOff size={16} /></button>}
          <button aria-label="Fullscreen" onClick={() => { const el = box.current; if (document.fullscreenElement) void document.exitFullscreen(); else void el?.requestFullscreen?.(); }} className="flex h-8 w-8 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"><Maximize2 size={16} /></button>
        </div>
      )}
      {stats && !sm && present && <StatsPanel identity={p.identity} source="screen" />}
    </div>
  );
}
