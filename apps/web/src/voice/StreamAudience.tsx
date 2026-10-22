/** Go Live audience: who is watching a stream, the viewer cap, removing viewers, and the viewer-side "may I watch" handshake. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, UserX, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Perm, type Id, type VoiceState } from '@jorcord/shared';
import { Avatar } from '@/components/ui/Avatar';
import { api } from '@/lib/api';
import { displayName } from '@/lib/format';
import { myChannelPerms } from '@/lib/session';
import { useData } from '@/stores/data';
import { useLiveVoice } from '@/stores/livevoice';
import { toastError } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { t } from '@/i18n';

/** Viewer cap choices offered to the streamer; `null` = as many as the server allows. */
export const VIEWER_LIMIT_CHOICES: (number | null)[] = [null, 1, 2, 5, 10, 25, 50];
export const limitLabel = (n: number | null) => (n === null ? t('No limit') : String(n));

/** Members of the channel currently watching `streamerId`. */
export function useViewers(channelId: Id | null, streamerId: Id): VoiceState[] {
  return useData(useShallow((s) => (channelId ? Object.values(s.voiceStates).filter((v) => v.channelId === channelId && v.watching === streamerId) : [])));
}

export type WatchGate = 'pending' | 'ok' | 'full' | 'kicked';

// Leaving a tile for a moment (layout change, focusing another stream) must not flicker the viewer count: stop watching only
// when no tile for the same stream came back shortly after.
const pendingStop = new Map<string, ReturnType<typeof setTimeout>>();
const STOP_DELAY_MS = 1500;

/**
 * Viewer side of Go Live. While `enabled` (a remote stream I have not turned off) the server is asked to count me as a viewer.
 * It waits until the gateway has announced the stream. It can refuse: the stream is full (409 STREAM_FULL) or the streamer removed me (403 STREAM_VIEWER_KICKED); the tile then
 * shows why instead of the video. Anything else (an older server, a network error) is treated as allowed.
 */
export function useStreamGate(channelId: Id | null, streamerId: Id, enabled: boolean): { gate: WatchGate; limit: number | null; retry: () => void } {
  const meId = useData((s) => s.me?.id);
  const kickedHere = useLiveVoice((s) => !!meId && s.isKicked(channelId ?? '', streamerId, meId));
  // the media track can show up before the gateway says the streamer is live: the server would answer 404, so wait for the announcement
  const announced = useData((s) => !!s.voiceStates[streamerId]?.streaming);
  const [gate, setGate] = useState<WatchGate>('pending');
  const [limit, setLimit] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${channelId}:${streamerId}`;
  useEffect(() => {
    if (!enabled || !channelId || !announced) { setGate('pending'); return; }
    clearTimeout(pendingStop.get(key)); pendingStop.delete(key);
    let dead = false;
    api.voice.streamWatch(channelId, streamerId, true)
      .then(() => { if (!dead) setGate('ok'); })
      .catch((e: { code?: string; details?: { limit?: number } }) => {
        if (dead) return;
        if (e?.code === 'STREAM_FULL') { setLimit(e.details?.limit ?? null); setGate('full'); }
        else if (e?.code === 'STREAM_VIEWER_KICKED') setGate('kicked');
        else setGate('ok');
      });
    return () => {
      dead = true;
      pendingStop.set(key, setTimeout(() => { pendingStop.delete(key); void api.voice.streamWatch(channelId, streamerId, false).catch(() => {}); }, STOP_DELAY_MS));
    };
  }, [enabled, announced, channelId, streamerId, key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { gate: kickedHere ? 'kicked' : gate, limit, retry };
}

/** "N watching" chip on a stream tile; opens the list of viewers with the streamer's / moderators' controls. */
export function StreamAudience({ streamerId }: { streamerId: Id }) {
  const channelId = useVoiceUI((s) => s.connectedChannelId);
  const meId = useData((s) => s.me?.id);
  const viewers = useViewers(channelId, streamerId);
  const streamer = useData((s) => s.voiceStates[streamerId]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!channelId) return null;
  const limit = streamer?.streamViewerLimit ?? null;
  return (
    <div ref={box} className="relative" onClick={(e) => e.stopPropagation()}>
      <button aria-label={`${t('Who is watching')}: ${viewers.length}`} aria-expanded={open} aria-haspopup="dialog" data-testid="stream-viewers-button" onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded bg-black/60 px-2 text-xs font-semibold text-white hover:bg-black/80">
        <Eye size={14} aria-hidden /><span data-testid="stream-viewer-count">{viewers.length}{limit !== null ? ` / ${limit}` : ''}</span>
      </button>
      {open && <AudiencePanel channelId={channelId} streamerId={streamerId} isMe={streamerId === meId} viewers={viewers} limit={limit} close={() => setOpen(false)} />}
    </div>
  );
}

function AudiencePanel({ channelId, streamerId, isMe, viewers, limit, close }: { channelId: Id; streamerId: Id; isMe: boolean; viewers: VoiceState[]; limit: number | null; close: () => void }) {
  const users = useData((s) => s.users);
  const kickedIds = useLiveVoice((s) => s.kicked[`${channelId}:${streamerId}`]);
  const canKick = isMe || (myChannelPerms(channelId) & Perm.MOVE_MEMBERS) !== 0n;
  const [cap, setCap] = useState<number | null>(null);
  // the list endpoint knows the kick list (streamer / moderators) and the effective cap, which the voice states do not carry
  useEffect(() => {
    let dead = false;
    api.voice.streams(channelId).then((list) => {
      const s = list.find((x) => x.streamerId === streamerId); if (!s || dead) return;
      setCap(s.effectiveLimit); if (s.kicked) useLiveVoice.getState().setKicked(channelId, streamerId, s.kicked);
    }).catch(() => {});
    return () => { dead = true; };
  }, [channelId, streamerId]);
  const name = (id: Id) => (users[id] ? displayName(users[id]!) : t('Unknown'));
  const choices = VIEWER_LIMIT_CHOICES.includes(limit) ? VIEWER_LIMIT_CHOICES : [...VIEWER_LIMIT_CHOICES, limit].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const kick = (id: Id, on: boolean) => void api.voice.streamKick(channelId, streamerId, id, on).catch(toastError);
  return (
    <div role="dialog" aria-label={t('Who is watching')} data-testid="stream-viewers-panel" className="absolute end-0 top-9 z-20 w-64 rounded-lg bg-float p-3 text-sm text-header shadow-elev">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{t('Watching')} — {viewers.length}{cap !== null && cap !== Infinity && cap < 1000 ? ` / ${cap}` : ''}</h3>
        <button aria-label={t('Close')} onClick={close} className="rounded p-1 text-muted hover:text-header"><X size={14} /></button>
      </div>
      {isMe && (
        <label className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">{t('Viewer limit')}
          <select className="field !w-auto !py-0.5" aria-label={t('Viewer limit')} value={limit ?? ''} onChange={(e) => void api.voice.streamLimit(channelId, e.target.value === '' ? null : Number(e.target.value)).catch(toastError)}>
            {choices.map((c) => <option key={c ?? 'none'} value={c ?? ''}>{limitLabel(c)}</option>)}
          </select>
        </label>)}
      {viewers.length === 0 ? <p className="text-muted" data-testid="stream-no-viewers">{t('Nobody is watching yet.')}</p> : (
        <ul className="grid max-h-48 gap-1 overflow-y-auto" aria-label={t('Viewers')}>
          {viewers.map((v) => (
            <li key={v.userId} data-testid="stream-viewer" className="flex items-center gap-2">
              <Avatar user={users[v.userId] ?? { id: v.userId, username: v.userId, displayName: null, avatar: null }} size={22} />
              <span className="min-w-0 flex-1 truncate">{name(v.userId)}</span>
              {canKick && v.userId !== streamerId && <button aria-label={`${t('Remove')} ${name(v.userId)} ${t('from the stream')}`} title={t('Remove from stream')} onClick={() => kick(v.userId, true)} className="rounded p-1 text-muted hover:text-danger"><UserX size={14} /></button>}
            </li>))}
        </ul>)}
      {canKick && !!kickedIds?.length && (
        <>
          <h4 className="mb-1 mt-3 text-xs font-semibold uppercase text-muted">{t('Removed from this stream')}</h4>
          <ul className="grid gap-1" aria-label={t('Removed viewers')}>
            {kickedIds.map((id) => (
              <li key={id} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-muted">{name(id)}</span>
                <button className="btn btn-secondary !px-2 !py-0.5 text-xs" onClick={() => kick(id, false)}>{t('Allow again')}</button></li>))}
          </ul>
        </>)}
    </div>
  );
}
