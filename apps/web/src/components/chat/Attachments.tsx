import { useState } from 'react';
import { Download, File as FileIcon, FileText, Music, Play } from 'lucide-react';
import type { Attachment, Embed } from '@jorcord/shared';
import { fileUrl, fmtBytes, isAudio, isImage, isVideo } from '@/lib/format';
import { useUI } from '@/stores/ui';

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
      <button onClick={() => setShown(true)} className="absolute inset-0 flex items-center justify-center" aria-label="Reveal spoiler"><span className="rounded-full bg-black/70 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">Spoiler</span></button>
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
        <audio src={url} controls preload="none" className="w-full" />
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

export function EmbedView({ e }: { e: Embed }) {
  const openModal = useUI((s) => s.openModal);
  const color = e.color != null ? '#' + (e.color >>> 0).toString(16).padStart(6, '0').slice(-6) : 'rgb(var(--active))';
  if (e.type === 'image' && (e.image || e.url)) return <img src={e.image ?? e.url} alt="" loading="lazy" onClick={() => openModal({ kind: 'image', url: (e.image ?? e.url)! })} className="max-h-[300px] max-w-[min(100%,400px)] cursor-zoom-in rounded-lg" />;
  if (e.type === 'video' && e.video) return <video src={e.video} controls playsInline className="max-h-[300px] max-w-[min(100%,400px)] rounded-lg bg-black" poster={e.thumbnail} />;
  const hasThumbOnly = e.thumbnail && !e.image;
  return (
    <article className="max-w-[432px] overflow-hidden rounded border-l-4 bg-side" style={{ borderLeftColor: color }}>
      <div className="flex gap-4 p-3 pr-4">
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
void Play;
