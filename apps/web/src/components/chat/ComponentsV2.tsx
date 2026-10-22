/** Components V2: layout-only messages built from containers, sections, text displays, media galleries, files, separators and thumbnails. */
import { useState } from 'react';
import { Download, File as FileIcon } from 'lucide-react';
import { ComponentType as CT, MessageFlags } from '@jorcord/shared';
import type { Component, Message } from '@jorcord/shared';
import { cx, fileUrl, fmtBytes } from '@/lib/format';
import { guardFile } from '@/lib/links';
import { Markdown } from './Markdown';
import { ButtonView, SelectView } from './MessageExtras';
import { t } from '@/i18n';

export const isComponentsV2 = (m: Pick<Message, 'flags'>) => ((m.flags ?? 0) & MessageFlags.IS_COMPONENTS_V2) !== 0;

const ATTACH = 'attachment://';
/** `attachment://name` resolves against the message's own files; anything else is an http(s) URL used as is. */
export function resolveMedia(m: Pick<Message, 'attachments'>, url: string): { url: string; name: string; size: number | null; description?: string } | null {
  if (url.startsWith(ATTACH)) {
    const name = url.slice(ATTACH.length); const a = m.attachments.find((x) => x.filename === name);
    return a ? { url: fileUrl(a.url)!, name: a.filename, size: a.size } : null;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, name: url.split('/').pop() || url, size: null };
}

function Media({ m, url, description, spoiler, className }: { m: Message; url: string; description?: string | null; spoiler?: boolean; className?: string }) {
  const [shown, setShown] = useState(!spoiler); const r = resolveMedia(m, url);
  if (!r) return <div className="rounded bg-side p-2 text-xs text-muted">{t('Media unavailable')}</div>;
  const video = /\.(mp4|webm|mov)(\?|$)/i.test(r.name);
  return (
    <div className="relative overflow-hidden rounded-lg">
      {video
        ? <video src={r.url} controls preload="metadata" className={cx('max-h-[300px] w-full bg-black', className, !shown && 'blur-[44px]')} />
        : <img src={r.url} alt={description ?? ''} loading="lazy" referrerPolicy="no-referrer" className={cx('block w-full object-cover', className, !shown && 'blur-[44px]')} />}
      {!shown && <button type="button" onClick={() => setShown(true)} className="absolute inset-0 flex items-center justify-center" aria-label={t('Reveal spoiler')}><span className="rounded-full bg-black/70 px-3 py-1 text-xs font-bold uppercase text-white">{t('Spoiler')}</span></button>}
    </div>
  );
}

function Node({ m, c }: { m: Message; c: Component }) {
  switch (c.type) {
    case CT.TEXT_DISPLAY: return <div data-v2="text" className="text-[16px] leading-[1.375rem] text-normal"><Markdown content={c.content ?? ''} guildId={m.guildId} /></div>;
    case CT.SECTION: return (
      <div data-v2="section" className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">{(c.components ?? []).map((x, i) => <Node key={i} m={m} c={x} />)}</div>
        {c.accessory && (c.accessory.type === CT.THUMBNAIL
          ? <div className="w-20 shrink-0 sm:w-24"><Media m={m} url={c.accessory.media?.url ?? ''} description={c.accessory.description} spoiler={c.accessory.spoiler} className="aspect-square" /></div>
          : <div className="shrink-0"><ButtonView m={m} c={c.accessory} /></div>)}
      </div>
    );
    case CT.THUMBNAIL: return <div className="w-24"><Media m={m} url={c.media?.url ?? ''} description={c.description} spoiler={c.spoiler} /></div>;
    case CT.MEDIA_GALLERY: {
      const items = c.items ?? []; const cols = items.length === 1 ? 'grid-cols-1' : 'grid-cols-2';
      return <div data-v2="gallery" className={cx('grid max-w-[520px] gap-1', cols)}>{items.map((it, i) => <Media key={i} m={m} url={it.media.url} description={it.description} spoiler={it.spoiler} className={items.length === 1 ? 'max-h-[360px]' : 'aspect-video'} />)}</div>;
    }
    case CT.FILE: {
      const r = resolveMedia(m, c.media?.url ?? '');
      if (!r) return <div className="rounded bg-side p-2 text-xs text-muted">{t('File unavailable')}</div>;
      return (
        <div data-v2="file" className="flex w-[min(100%,400px)] items-center gap-3 rounded-md border border-divider bg-side p-3">
          <FileIcon size={28} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-header">{r.name}</span>{r.size !== null && <span className="text-xs text-muted">{fmtBytes(r.size)}</span>}</div>
          <a href={r.url} download={r.name} aria-label={`Download ${r.name}`} className="text-interactive hover:text-header" onClick={(e) => guardFile(e, r.url, r.name, true)}><Download size={20} /></a>
        </div>
      );
    }
    case CT.SEPARATOR: return <div data-v2="separator" role="separator" className={cx(c.spacing === 2 ? 'my-3' : 'my-1', c.divider !== false && 'border-t border-divider')} />;
    case CT.ACTION_ROW: return (
      <div data-v2="row" className="flex flex-wrap items-center gap-2" role="group">
        {(c.components ?? []).map((x, j) => (x.type === CT.BUTTON ? <ButtonView key={x.customId ?? x.url ?? j} m={m} c={x} /> : <SelectView key={x.customId ?? j} m={m} c={x} />))}
      </div>
    );
    case CT.CONTAINER: {
      const accent = typeof c.accentColor === 'number' ? `#${c.accentColor.toString(16).padStart(6, '0')}` : null;
      return (
        <div data-v2="container" className="max-w-[520px] space-y-2 rounded-lg border border-divider bg-side p-3" style={accent ? { borderInlineStartColor: accent, borderInlineStartWidth: 4 } : undefined}>
          {(c.components ?? []).map((x, i) => <Node key={i} m={m} c={x} />)}
        </div>
      );
    }
    default: return null;
  }
}

/** The whole layout of a V2 message. */
export function ComponentsV2({ m }: { m: Message }) {
  const list = m.components ?? [];
  if (!list.length) return null;
  return <div data-testid="components-v2" className="mt-1 flex flex-col gap-2">{list.map((c, i) => <Node key={i} m={m} c={c} />)}</div>;
}
