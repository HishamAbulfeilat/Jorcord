import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Share2, Trash2 } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import { Modal } from '@/components/ui/primitives';
import { useClipUI } from '@/stores/clipui';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { api, type ClipMessage } from '@/lib/api';
import { fileUrl, fmtBytes } from '@/lib/format';
import { myChannelPerms } from '@/lib/session';
import { t } from '@/i18n';
import { canShareClip, getShareMax, shareDurationSeconds } from './clipBuffer';
import { loadClipLimits } from './clipLimits';

/** Clips channels I may post to, across my servers. */
export function shareTargets(): { id: string; label: string }[] {
  const s = useData.getState(); const out: { id: string; label: string }[] = [];
  for (const g of Object.values(s.guilds)) for (const c of Object.values(g.channels)) {
    if (!c.isClipsChannel) continue;
    const p = myChannelPerms(c.id);
    if ((p & Perm.SEND_MESSAGES) !== 0n && (p & Perm.ATTACH_FILES) !== 0n) out.push({ id: c.id, label: `${g.guild.name} / #${c.name}` });
  }
  return out;
}

export const clipFileName = (at: number, mime: string) => `clip-${new Date(at).toISOString().replace(/[:.]/g, '-')}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;

/** WebM from MediaRecorder carries no duration, so the player shows "Infinity" and cannot seek: seeking far forces it to measure. */
function useMeasuredDuration(video: React.RefObject<HTMLVideoElement>) {
  useEffect(() => {
    const v = video.current; if (!v) return;
    const fix = () => { if (v.duration === Infinity) { const done = () => { v.removeEventListener('timeupdate', done); v.currentTime = 0; }; v.addEventListener('timeupdate', done); v.currentTime = 1e101; } };
    v.addEventListener('loadedmetadata', fix);
    return () => v.removeEventListener('loadedmetadata', fix);
  }, [video]);
}

export function ClipPreviewModal({ close }: { close: () => void }) {
  const clip = useClipUI((s) => s.clip);
  // Created and revoked in the same effect: StrictMode runs effects twice in dev, which would revoke a memoized URL the <video> is still loading.
  const [url, setUrl] = useState('');
  useEffect(() => { if (!clip) { setUrl(''); return; } const u = URL.createObjectURL(clip.blob); setUrl(u); return () => URL.revokeObjectURL(u); }, [clip]);
  const video = useRef<HTMLVideoElement>(null); useMeasuredDuration(video);
  const targets = useMemo(shareTargets, []);
  const [, bump] = useState(0); useEffect(() => { void loadClipLimits().then(() => bump((n) => n + 1)); }, []); // the server's cap decides what can be shared
  const [target, setTarget] = useState(targets[0]?.id ?? ''); const [caption, setCaption] = useState(''); const [busy, setBusy] = useState(false);
  if (!clip) return <Modal title={t('Clip')} onClose={close}><p className="text-muted">{t('No clip to show.')}</p></Modal>;
  const shareable = canShareClip(clip.durationSec);
  const done = () => { useClipUI.getState().patch({ clip: null }); close(); };
  const share = async () => {
    setBusy(true);
    try {
      const att = await api.files.upload(new File([clip.blob], clipFileName(clip.at, clip.mimeType), { type: clip.mimeType }));
      await api.clips.post(target, { attachmentId: att.id, durationSeconds: shareDurationSeconds(clip.durationSec), content: caption.trim() || undefined });
      toast(t('Clip shared'), 'success'); done();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('Your clip')} onClose={done} width={560}
      footer={<><button className="btn btn-link" onClick={done}>{t('Discard')}</button>
        <a className="btn btn-secondary inline-flex items-center gap-2" href={url || undefined} download={clipFileName(clip.at, clip.mimeType)}><Download size={16} />{t('Download')}</a>
        <button className="btn btn-primary inline-flex items-center gap-2" disabled={busy || !shareable || !target} onClick={() => void share()}><Share2 size={16} />{busy ? t('Sharing…') : t('Share to clips channel')}</button></>}>
      <video ref={video} src={url || undefined} controls playsInline data-testid="clip-preview" className="aspect-video w-full rounded-lg bg-black" />
      <p className="mt-2 text-sm text-muted" data-testid="clip-meta">{Math.round(clip.durationSec)} s · {fmtBytes(clip.blob.size)}</p>
      {!shareable && <p role="note" className="mt-2 text-sm text-warn" data-testid="clip-too-long">{t('Clips shared to a channel can be at most {n} seconds. Download this one, or save a shorter clip to share it.').replace('{n}', String(getShareMax()))}</p>}
      {shareable && targets.length === 0 && <p role="note" className="mt-2 text-sm text-muted" data-testid="clip-no-channel">{t('None of your servers has a clips channel you can post in. A server admin can mark a text channel as a clips channel in its settings.')}</p>}
      {shareable && targets.length > 0 && (
        <div className="mt-3 grid gap-3">
          <label className="block"><span className="label">{t('Clips channel')}</span>
            <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('Clips channel')}>{targets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
          <label className="block"><span className="label">{t('Caption (optional)')}</span>
            <input className="field" maxLength={200} value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
        </div>)}
    </Modal>
  );
}

function ClipCard({ c, channelId, canDelete }: { c: ClipMessage; channelId: string; canDelete: boolean }) {
  const qc = useQueryClient(); const a = c.attachments[0];
  const video = useRef<HTMLVideoElement>(null); useMeasuredDuration(video);
  if (!a) return null;
  return (
    <li className="rounded-lg bg-side p-2" data-testid="clip-card">
      <video ref={video} src={fileUrl(a.url) ?? a.url} controls preload="metadata" playsInline className="aspect-video w-full rounded bg-black" aria-label={`${t('Clip by')} ${c.author.displayName ?? c.author.username}`} />
      <div className="mt-1 flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-header">{c.author.displayName ?? c.author.username}{c.content ? <span className="text-muted"> · {c.content}</span> : null}</span>
        <span className="flex shrink-0 items-center gap-2 text-muted">{c.durationSeconds ? `${c.durationSeconds}s` : null}
          {canDelete && <button className="rounded p-1 hover:text-danger" aria-label={t('Delete clip')} onClick={() => void api.clips.remove(channelId, c.clipId).then(() => qc.invalidateQueries({ queryKey: ['clips', channelId] })).catch(toastError)}><Trash2 size={16} /></button>}</span>
      </div>
    </li>
  );
}

export function ClipsViewerModal({ channelId, close }: { channelId: string; close: () => void }) {
  const me = useData((s) => s.me?.id); const canManage = (myChannelPerms(channelId) & Perm.MANAGE_MESSAGES) !== 0n;
  const q = useInfiniteQuery({
    queryKey: ['clips', channelId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.clips.list(channelId, pageParam),
    getNextPageParam: (last) => (last.length >= 24 ? last[last.length - 1]!.clipId : undefined),
  });
  const clips = q.data?.pages.flat() ?? [];
  return (
    <Modal title={t('Clips')} onClose={close} width={760}>
      {q.isLoading && <p className="text-muted" role="status">{t('Loading…')}</p>}
      {q.isError && <p className="text-danger" role="alert">{t('Could not load clips.')}</p>}
      {!q.isLoading && !q.isError && clips.length === 0 && <p className="text-muted" data-testid="clips-empty">{t('No clips yet. Record one from a call: Clip button > Save clip.')}</p>}
      <ul className="grid gap-3 sm:grid-cols-2" aria-label={t('Clips')}>{clips.map((c) => <ClipCard key={c.clipId} c={c} channelId={channelId} canDelete={c.author.id === me || canManage} />)}</ul>
      {q.hasNextPage && <button className="btn btn-secondary mt-3" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('Load more')}</button>}
    </Modal>
  );
}
