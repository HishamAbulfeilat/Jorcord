import { useEffect, useRef, useState } from 'react';
import { Gamepad2, Pause, Play, X } from 'lucide-react';
import type { ChannelActivity } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useChannelActivities } from '@/stores/channelActivities';
import { t } from '@/i18n';
import { initialTicTacToeState } from './TicTacToe';
import { AppActivityLauncher } from './AppActivity';

/**
 * YouTube links only, from youtube.com or youtu.be. The id is exactly 11 URL-safe base64 characters.
 * Everything else (other hosts, playlist-only links, malformed ids) is rejected before it can reach an iframe.
 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export function parseYouTubeId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    const part = url.pathname.split('/').filter(Boolean)[0] ?? '';
    id = url.pathname === '/watch' ? url.searchParams.get('v') : ['embed', 'live', 'shorts', 'v'].includes(part) ? url.pathname.split('/').filter(Boolean)[1] ?? null : null;
  }
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
export const WATCH_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation';

/** The only player origin the client ever embeds or posts commands to. */
export function youTubeEmbedUrl(videoId: string): string {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error('Invalid YouTube video id');
  const query = new URLSearchParams({ enablejsapi: '1', rel: '0', modestbranding: '1', playsinline: '1' });
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}?${query.toString()}`;
}

export type YouTubeCommand = 'playVideo' | 'pauseVideo' | 'seekTo';
export function youTubeCommand(win: Window | null | undefined, func: YouTubeCommand, args: (string | number | boolean)[] = []): void {
  win?.postMessage(JSON.stringify({ event: 'command', func, args }), YOUTUBE_EMBED_ORIGIN);
}

export interface WatchState { videoId: string; position: number; playing: boolean }
/** Validate the opaque server state before using it as a video id or a player command. */
export function watchState(activity?: Pick<ChannelActivity, 'state'> | null): WatchState | null {
  if (!activity || !activity.state || typeof activity.state !== 'object') return null;
  const s = activity.state as Record<string, unknown>;
  if (typeof s.videoId !== 'string' || !VIDEO_ID_RE.test(s.videoId)) return null;
  const position = typeof s.position === 'number' && Number.isFinite(s.position) ? Math.max(0, s.position) : 0;
  return { videoId: s.videoId, position, playing: s.playing === true };
}

/**
 * Watch Together: paste a YouTube link, then the host's play/pause/seek changes go through the server, which pushes
 * ACTIVITY_UPDATE to everybody who can view the voice channel. Viewers apply the same commands to their own iframe.
 */
export function WatchTogetherPopover({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const active = useChannelActivities((s) => s.byChannel[channelId]?.find((a) => a.kind === 'youtube') ?? null);
  const ticTacToe = useChannelActivities((s) => s.byChannel[channelId]?.find((a) => a.kind === 'tictactoe') ?? null);
  const setChannel = useChannelActivities((s) => s.setChannel);
  const upsert = useChannelActivities((s) => s.upsert);
  const remove = useChannelActivities((s) => s.remove);
  const me = useData((s) => s.me?.id);
  const [url, setUrl] = useState('');
  const [seek, setSeek] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const state = watchState(active);
  const isHost = !!active && active.hostId === me;

  // The session list is fetched when the panel opens; later changes arrive as gateway events.
  useEffect(() => {
    let alive = true;
    api.activities.list(channelId).then((r) => { if (alive) setChannel(channelId, r.activities); }).catch(() => {});
    return () => { alive = false; };
  }, [channelId, setChannel]);

  useEffect(() => {
    const click = (e: MouseEvent) => { if ((e.target as Element)?.closest?.('[data-watch-together-toggle]')) return; if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [onClose]);

  const syncFrame = () => {
    if (!state) return;
    const win = frame.current?.contentWindow;
    youTubeCommand(win, 'seekTo', [state.position, true]);
    youTubeCommand(win, state.playing ? 'playVideo' : 'pauseVideo');
  };
  useEffect(() => { if (state) setSeek(Math.floor(state.position)); syncFrame(); }, [state?.videoId, state?.position, state?.playing, active?.updatedAt]);

  const patch = async (next: WatchState) => {
    if (!active || !isHost) return;
    setBusy(true); setError(null);
    try { upsert(await api.activities.update(active.id, next)); }
    catch (e) { setError((e as Error).message || t('Could not update the video')); }
    finally { setBusy(false); }
  };

  const start = async () => {
    const videoId = parseYouTubeId(url);
    if (!videoId) { setError(t('Paste a YouTube link from youtube.com or youtu.be.')); return; }
    setBusy(true); setError(null);
    try {
      upsert(await api.activities.start(channelId, { kind: 'youtube', state: { videoId, position: 0, playing: true } }));
      setUrl('');
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        try { setChannel(channelId, (await api.activities.list(channelId)).activities); } catch { /* the next event catches up */ }
      } else setError((e as Error).message || t('Could not start Watch Together'));
    } finally { setBusy(false); }
  };

  const end = async () => {
    if (!active) return;
    setBusy(true); setError(null);
    try { await api.activities.end(active.id); remove(active.id, channelId); }
    catch (e) { setError((e as Error).message || t('Could not end Watch Together')); }
    finally { setBusy(false); }
  };

  const startTicTacToe = async () => {
    setBusy(true); setError(null);
    try { upsert(await api.activities.start(channelId, { kind: 'tictactoe', state: initialTicTacToeState() })); }
    catch (e) {
      if ((e as { status?: number }).status === 409) {
        try { setChannel(channelId, (await api.activities.list(channelId)).activities); } catch { /* the next event catches up */ }
      } else setError((e as Error).message || t('Could not start Tic-Tac-Toe'));
    } finally { setBusy(false); }
  };

  const endTicTacToe = async () => {
    if (!ticTacToe) return;
    setBusy(true); setError(null);
    try { await api.activities.end(ticTacToe.id); remove(ticTacToe.id, channelId); }
    catch (e) { setError((e as Error).message || t('Could not end Tic-Tac-Toe')); }
    finally { setBusy(false); }
  };

  return (
    <div ref={box} role="dialog" aria-label={t('Watch Together')} data-testid="watch-together"
      className="fixed inset-x-3 bottom-[88px] z-50 animate-pop rounded-lg bg-float p-3 text-start shadow-elev md:absolute md:inset-x-auto md:bottom-full md:end-0 md:mb-3 md:w-[420px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wide text-interactive">{t('Watch Together')}</div>
        <button aria-label={t('Close')} onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-interactive hover:bg-hover"><X size={16} /></button>
      </div>
      {error && <p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      {!state ? (
        <div className="grid gap-2">
          <label htmlFor="watch-url" className="text-sm text-header">{t('YouTube link')}</label>
          <input id="watch-url" aria-label={t('YouTube link')} value={url} placeholder="https://youtube.com/watch?v=…"
            onChange={(e) => { setUrl(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') void start(); }}
            className="field !min-h-0 w-full py-2" />
          <button className="btn btn-primary btn-lg w-full" onClick={() => void start()} disabled={busy}>{t('Start Watch Together')}</button>
        </div>
      ) : (
        <>
          <div className="relative aspect-video overflow-hidden rounded bg-black">
            <iframe ref={frame} data-testid="watch-together-frame" title={t('YouTube video')} src={youTubeEmbedUrl(state.videoId)}
              sandbox={WATCH_IFRAME_SANDBOX} allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"
              onLoad={syncFrame} className="absolute inset-0 h-full w-full" />
          </div>
          {isHost ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className="btn btn-secondary" aria-label={state.playing ? t('Pause') : t('Play')} onClick={() => void patch({ ...state, playing: !state.playing })} disabled={busy}>
                {state.playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <label htmlFor="watch-seek" className="sr-only">{t('Seek to (seconds)')}</label>
              <input id="watch-seek" aria-label={t('Seek to (seconds)')} type="number" min={0} value={seek} onChange={(e) => setSeek(Math.max(0, Number(e.target.value) || 0))} className="field !min-h-0 w-24 py-1" />
              <button className="btn btn-secondary" onClick={() => void patch({ ...state, position: Math.max(0, seek) })} disabled={busy}>{t('Seek')}</button>
              <button className="btn btn-danger ms-auto" onClick={() => void end()} disabled={busy}>{t('End')}</button>
            </div>
          ) : <p className="mt-2 text-xs text-muted">{t('The host controls playback.')}</p>}
        </>
      )}
      <div className="mt-3 border-t border-divider/70 pt-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-interactive"><Gamepad2 size={14} />{t('Tic-Tac-Toe')}</div>
        {ticTacToe
          ? ticTacToe.hostId === me
            ? <button className="btn btn-danger btn-lg w-full" onClick={() => void endTicTacToe()} disabled={busy}>{t('End Tic-Tac-Toe')}</button>
            : <p className="text-xs text-muted">{t('Tic-Tac-Toe is running in this channel.')}</p>
          : <button className="btn btn-secondary btn-lg w-full" onClick={() => void startTicTacToe()} disabled={busy}>{t('Start Tic-Tac-Toe')}</button>}
      </div>
      <AppActivityLauncher channelId={channelId} />
    </div>
  );
}
