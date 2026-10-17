import { useEffect, useRef, useState } from 'react';
import { Download, File as FileIcon, FileText, Music, Pause, Play } from 'lucide-react';
import type { Attachment, Embed } from '@jorcord/shared';
import { fileUrl, fmtBytes, isAudio, isImage, isVideo } from '@/lib/format';
import { fmtVoiceDuration, VOICE_BARS, waveformPeaks } from '@/lib/voiceMsg';
import { useUI } from '@/stores/ui';
import { t } from '@/i18n';

function fit(w: number | null, h: number | null, maxW = 400, maxH = 300) {
  if (!w || !h) return { width: undefined, height: undefined, aspect: undefined };
  const r = Math.min(maxW / w, maxH / h, 1);
  return { width: Math.round(w * r), height: Math.round(h * r), aspect: `${w} / ${h}` };
}

function Spoilered({ children, on }: { children: React.ReactNode; on: boolean }) {
  const [shown, setShown] = useState(false);
  if (!on || shown) return <>{children}</>;
  return (
    <div className="relative inline-block overflow-hidden rounded-lg">
      <div className="pointer-events-none blur-[44px]" aria-hidden>{children}</div>
      <button onClick={() => setShown(true)} className="absolute inset-0 flex items-center justify-center" aria-label={t('Reveal spoiler')}><span className="rounded-full bg-black/70 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">{t('Spoiler')}</span></button>
    </div>
  );
}

export function AttachmentView({ a }: { a: Attachment }) {
  const openModal = useUI((s) => s.openModal);
  const url = fileUrl(a.url)!; const spoiler = a.spoiler || a.filename.startsWith('SPOILER_');
  if (isImage(a.contentType)) {
    const d = fit(a.width, a.height);
    return (
      <Spoilered on={spoiler}>
        <button onClick={() => openModal({ kind: 'image', url, name: a.filename })} className="block cursor-zoom-in overflow-hidden rounded-lg" aria-label={`Open image ${a.filename}`}>
          <img src={url} alt={a.filename} loading="lazy" width={d.width} height={d.height} style={{ aspectRatio: d.aspect, maxWidth: 'min(100%, 400px)', maxHeight: 300, width: d.width ? undefined : 'auto', height: 'auto' }} className="block rounded-lg object-contain" />
        </button>
      </Spoilered>
    );
  }
  if (isVideo(a.contentType)) {
    const d = fit(a.width, a.height, 400, 300);
    return <Spoilered on={spoiler}><video src={url} controls preload="metadata" playsInline className="max-h-[300px] max-w-full rounded-lg bg-black" style={{ width: d.width, aspectRatio: d.aspect }} /></Spoilered>;
  }
  if (isAudio(a.contentType)) {
    return (
      <div className="w-[min(100%,400px)] rounded-md border border-divider bg-side p-3">
        <div className="mb-2 flex items-center gap-2 text-sm"><Music size={18} className="text-muted" /><a href={url} download className="truncate font-medium">{a.filename}</a><span className="text-xs text-muted">{fmtBytes(a.size)}</span></div>
        <VoicePlayer src={url} />
      </div>
    );
  }
  const Icon = a.contentType.startsWith('text/') || a.contentType.includes('pdf') ? FileText : FileIcon;
  return (
    <div className="flex w-[min(100%,400px)] items-center gap-3 rounded-md border border-divider bg-side p-3">
      <Icon size={32} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1"><a href={url} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium">{a.filename}</a><span className="text-xs text-muted">{fmtBytes(a.size)}</span></div>
      <a href={url} download={a.filename} aria-label={`Download ${a.filename}`} className="text-interactive hover:text-header"><Download size={20} /></a>
    </div>
  );
}

export function WaveformBars({ peaks, progress = 0 }: { peaks: number[]; progress?: number }) {
  const max = Math.max(...peaks, 0.15);
  const played = progress > 0 ? Math.min(peaks.length, Math.ceil(progress * peaks.length)) : 0;
  return (
    <div data-testid="waveform" className="flex h-8 flex-1 items-center gap-[2px]" aria-hidden>
      {peaks.map((p, i) => (
        <span key={i} className="w-[3px] rounded-full bg-brand" style={{ height: `${Math.max(12, Math.round((p / max) * 100))}%`, opacity: i < played ? 1 : 0.4 }} />
      ))}
    </div>
  );
}

const SPEEDS = [1, 1.5, 2];
const FLAT_PEAKS = new Array<number>(VOICE_BARS).fill(0.5);

/** Discord-style audio bubble: play/pause over a waveform, played bars highlighted, speed cycling 1x -> 1.5x -> 2x. */
export function VoicePlayer({ src, durationHint }: { src: string; durationHint?: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => { // decode the audio for a real waveform; a flat one is better than a broken player
    let dead = false;
    (async () => {
      try {
        const ab = await (await fetch(src)).arrayBuffer();
        const ctx = new AudioContext();
        const buf = await ctx.decodeAudioData(ab);
        void ctx.close().catch(() => {});
        if (!dead) setPeaks(waveformPeaks(buf.getChannelData(0)));
      } catch { if (!dead) setPeaks(FLAT_PEAKS); }
    })();
    return () => { dead = true; };
  }, [src]);

  const progress = duration > 0 ? at / duration : 0;
  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); return; }
    void el.play().catch(() => {});
  };
  const cycle = () => {
    const el = audioRef.current;
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
    setSpeed(next);
    if (el) el.playbackRate = next;
  };
  const seek = (e: React.MouseEvent) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (r.width <= 0) return;
    const t2 = Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration));
    el.currentTime = t2; setAt(t2);
  };

  return (
    <div data-testid="voice-player" className="flex items-center gap-2">
      <audio ref={audioRef} src={src} preload="metadata" hidden data-testid="voice-player-audio"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setAt(0); }}
        onTimeUpdate={() => setAt(audioRef.current?.currentTime ?? 0)} onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)} />
      <button aria-label={playing ? t('Pause') : t('Play')} data-testid="voice-player-play" onClick={toggle}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white hover:bg-brand/90">{playing ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}</button>
      <span className="relative flex min-w-0 flex-1 cursor-pointer" onClick={seek}>
        <WaveformBars peaks={peaks ?? FLAT_PEAKS} progress={progress} />
      </span>
      <span className="w-10 shrink-0 text-xs tabular-nums text-muted" data-testid="voice-player-duration">{fmtVoiceDuration(duration)}</span>
      <button aria-label={t('Playback speed')} data-testid="voice-player-speed" onClick={cycle} title={t('Playback speed')}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-interactive hover:text-header">{speed}x</button>
    </div>
  );
}

export function EmbedView({ e }: { e: Embed }) {
  const openModal = useUI((s) => s.openModal);
  const color = e.color != null ? '#' + (e.color >>> 0).toString(16).padStart(6, '0').slice(-6) : 'rgb(var(--active))';
  if (e.type === 'image' && (e.image || e.url)) return <img src={e.image ?? e.url} alt="" loading="lazy" onClick={() => openModal({ kind: 'image', url: (e.image ?? e.url)! })} className="max-h-[300px] max-w-[min(100%,400px)] cursor-zoom-in rounded-lg" />;
  if (e.type === 'video' && e.video) return <video src={e.video} controls playsInline className="max-h-[300px] max-w-[min(100%,400px)] rounded-lg bg-black" poster={e.thumbnail} />;
  const hasThumbOnly = e.thumbnail && !e.image;
  return (
    <article className="max-w-[432px] overflow-hidden rounded border-s-4 bg-side" style={{ borderLeftColor: color }}>
      <div className="flex gap-4 p-3 pe-4">
        <div className="min-w-0 flex-1">
          {e.siteName && <div className="mb-1 text-xs text-muted">{e.siteName}</div>}
          {e.author && <div className="mb-1 text-sm font-semibold text-header">{e.author}</div>}
          {e.title && (e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="mb-1 block font-semibold">{e.title}</a> : <div className="mb-1 font-semibold text-header">{e.title}</div>)}
          {e.description && <div className="line-clamp-6 whitespace-pre-wrap break-words text-sm text-normal">{e.description}</div>}
          {e.fields && e.fields.length > 0 && <div className="mt-2 grid grid-cols-3 gap-2">{e.fields.map((f, i) => <div key={i} className={f.inline ? '' : 'col-span-3'}><div className="text-sm font-semibold text-header">{f.name}</div><div className="whitespace-pre-wrap text-sm">{f.value}</div></div>)}</div>}
          {e.image && <img src={e.image} alt="" loading="lazy" onClick={() => openModal({ kind: 'image', url: e.image! })} className="mt-3 max-h-[300px] w-full cursor-zoom-in rounded object-cover" />}
          {e.footer && <div className="mt-2 text-xs text-muted">{e.footer}</div>}
        </div>
        {hasThumbOnly && <img src={e.thumbnail} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded object-cover" />}
      </div>
    </article>
  );
}
