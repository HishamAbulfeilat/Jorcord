import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Hash, Users } from 'lucide-react';
import type { Channel, Message } from '@jorcord/shared';
import { useMessages, useMessages as useMsgStore } from '@/stores/messages';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { api } from '@/lib/api';
import { compareId, fmtDateDivider, msgTime, sameDay, dmName } from '@/lib/format';
import { MessageItem, PendingItem } from './MessageItem';
import { Spinner } from '@/components/ui/primitives';
import { ackLater } from '@/lib/session';
import { cx } from '@/lib/format';
import { toPlain, parseInline } from '@/lib/markdown';
import { t } from '@/i18n';

const PAGE = 50;
type Row =
  | { key: string; kind: 'date'; label: string }
  | { key: string; kind: 'new' }
  | { key: string; kind: 'intro' }
  | { key: string; kind: 'msg'; m: Message; grouped: boolean }
  | { key: string; kind: 'pending'; nonce: string; grouped: boolean };

export function buildRows(list: Message[], pending: { nonce: string; createdAt: number }[], opts: { lastRead: string | null; hasMoreOlder: boolean; meId?: string }): Row[] {
  const rows: Row[] = [];
  if (!opts.hasMoreOlder) rows.push({ key: 'intro', kind: 'intro' });
  let prev: Message | null = null; let newPlaced = false;
  for (const m of list) {
    const t = msgTime(m.id, m.createdAt);
    const newDay = !prev || !sameDay(msgTime(prev.id, prev.createdAt), t);
    if (newDay) rows.push({ key: `d${t - (t % 86400000)}-${m.id}`, kind: 'date', label: fmtDateDivider(t) });
    if (!newPlaced && opts.lastRead && compareId(m.id, opts.lastRead) > 0 && m.author.id !== opts.meId && prev) { rows.push({ key: 'new', kind: 'new' }); newPlaced = true; }
    const grouped = !!prev && !newDay && prev.author.id === m.author.id && prev.type !== 'join' && prev.type !== 'pin' && m.type !== 'join' && m.type !== 'pin' && t - msgTime(prev.id, prev.createdAt) < 7 * 60000 && !m.replyTo && !m.interaction && !prev.components?.length && !prev.webhookId === !m.webhookId && !(rows[rows.length - 1].kind === 'new');
    rows.push({ key: m.id, kind: 'msg', m, grouped });
    prev = m;
  }
  pending.forEach((p, i) => rows.push({ key: `p${p.nonce}`, kind: 'pending', nonce: p.nonce, grouped: i > 0 || (!!prev && prev.author.id === opts.meId && Date.now() - msgTime(prev.id, prev.createdAt) < 7 * 60000) }));
  return rows;
}

export function MessageList({ channel, lastReadSnapshot }: { channel: Channel; lastReadSnapshot: string | null }) {
  const cid = channel.id;
  const state = useMessages((s) => s.ch[cid]); const pendingAll = useMessages((s) => s.pending);
  const pending = useMemo(() => pendingAll.filter((p) => p.channelId === cid), [pendingAll, cid]);
  const me = useData((s) => s.me);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true); const [showJump, setShowJump] = useState(false); const [newBelow, setNewBelow] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  const store = useMsgStore.getState;

  const rows = useMemo(() => buildRows(state?.list ?? [], pending, { lastRead: lastReadSnapshot, hasMoreOlder: state?.hasMoreOlder ?? true, meId: me?.id }), [state?.list, state?.hasMoreOlder, pending, lastReadSnapshot, me?.id]);
  const rowsRef = useRef(rows); rowsRef.current = rows;

  const virt = useVirtualizer({
    count: rows.length, getScrollElement: () => scroller.current, overscan: 12,
    estimateSize: (i) => { const r = rows[i]; return r.kind === 'msg' ? (r.grouped ? 26 : 62) : r.kind === 'intro' ? 160 : 34; },
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  // initial load
  const load = useCallback(async (around?: string) => {
    store().setLoading(cid, true);
    try { const r = await api.messages.list(cid, around ? { around, limit: PAGE } : { limit: PAGE }); useData.getState().putUsers(r.map((m) => m.author)); store().init(cid, r, PAGE, around); }
    catch (e) { store().setLoading(cid, false, (e as Error).message); }
  }, [cid, store]);
  useEffect(() => { if (!state?.loadedInitial) { didInitial.current = false; load(); } }, [cid, state?.loadedInitial]); // eslint-disable-line

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scroller.current; if (!el) return;
    const n = rowsRef.current.length; if (!n) return;
    virt.scrollToIndex(n - 1, { align: 'end', behavior: smooth ? 'smooth' : 'auto' });
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); });
  }, [virt]);

  // first paint after load: stick to bottom (or jump target)
  const didInitial = useRef(false);
  useLayoutEffect(() => {
    if (!state?.loadedInitial || didInitial.current) return;
    didInitial.current = true;
    if (state.jumpTo) jumpTo(state.jumpTo, false); else scrollToEnd();
  }, [state?.loadedInitial, state?.initSeq]); // eslint-disable-line

  // preserve scroll when older messages prepended
  useLayoutEffect(() => {
    const a = anchor.current; if (!a) return;
    const idx = rows.findIndex((r) => r.key === a.key); if (idx < 0) { anchor.current = null; return; }
    virt.scrollToIndex(idx, { align: 'start' });
    const el = scroller.current; if (el) el.scrollTop = el.scrollTop - a.delta;
    anchor.current = null;
  }, [state?.list[0]?.id]); // eslint-disable-line

  // new content while pinned to bottom
  const lastKey = rows[rows.length - 1]?.key;
  const prevLast = useRef(lastKey);
  useLayoutEffect(() => {
    if (prevLast.current === lastKey) return;
    prevLast.current = lastKey;
    const last = rows[rows.length - 1];
    const mine = last?.kind === 'pending' || (last?.kind === 'msg' && last.m.author.id === me?.id);
    if (atBottom.current || mine) scrollToEnd(); else setNewBelow((n) => n + 1);
  }, [lastKey]); // eslint-disable-line

  // stay pinned when content height changes (images loading etc.)
  const total = virt.getTotalSize();
  useLayoutEffect(() => { if (atBottom.current && didInitial.current) { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; } }, [total]);

  const loadingOlder = useRef(false);
  /** Mark the channel read when its newest message is on screen and the window is focused. */
  const ackIfViewing = () => {
    const last = state?.list[state.list.length - 1];
    if (!last || state?.hasMoreNewer || !document.hasFocus()) return;
    const rs = useData.getState().readStates[cid];
    if (compareId(last.id, rs?.lastReadId) > 0 || (rs?.mentionCount ?? 0) > 0) ackLater(cid, last.id);
  };
  // Short channels never scroll, so no scroll event fires: ack once the list has painted at the bottom.
  useEffect(() => {
    if (!state?.loadedInitial) return;
    const t = setTimeout(() => { const el = scroller.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) ackIfViewing(); }, 150);
    return () => clearTimeout(t);
  }, [state?.loadedInitial, state?.initSeq, state?.list.length, cid]); // eslint-disable-line
  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = dist < 80;
    atBottom.current = bottom && !state?.hasMoreNewer;
    setShowJump(dist > 600 || !!state?.hasMoreNewer);
    if (bottom && !state?.hasMoreNewer) { setNewBelow(0); ackIfViewing(); }
    if (el.scrollTop < 500 && state?.hasMoreOlder && !state.loading && !loadingOlder.current && state.list.length) {
      loadingOlder.current = true;
      const first = virt.getVirtualItems()[0];
      if (first) anchor.current = { key: rows[first.index].key, delta: first.start - el.scrollTop };
      store().setLoading(cid, true);
      api.messages.list(cid, { before: state.list[0].id, limit: PAGE })
        .then((r) => { useData.getState().putUsers(r.map((m) => m.author)); store().prepend(cid, r, PAGE); })
        .catch(() => store().setLoading(cid, false))
        .finally(() => { loadingOlder.current = false; });
    }
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 500 && state?.hasMoreNewer && !state.loading && state.list.length) {
      store().setLoading(cid, true);
      api.messages.list(cid, { after: state.list[state.list.length - 1].id, limit: PAGE }).then((r) => store().append(cid, r, PAGE)).catch(() => store().setLoading(cid, false));
    }
  };

  // ack when focus returns & at bottom
  useEffect(() => {
    const f = () => { if (atBottom.current) onScroll(); };
    window.addEventListener('focus', f); return () => window.removeEventListener('focus', f);
  });

  const jumpTo = useCallback(async (mid: string, smooth = true) => {
    const idx = rowsRef.current.findIndex((r) => r.key === mid);
    if (idx >= 0) {
      virt.scrollToIndex(idx, { align: 'center', behavior: smooth ? 'smooth' : 'auto' });
      setFlashId(mid); setTimeout(() => setFlashId(null), 2200);
      requestAnimationFrame(() => document.getElementById(`msg-${mid}`)?.scrollIntoView({ block: 'center' }));
    } else { didInitial.current = false; await load(mid); }
  }, [virt, load]);
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d.channelId === cid) jumpTo(d.messageId); };
    window.addEventListener('jorcord:jump', h); return () => window.removeEventListener('jorcord:jump', h);
  }, [cid, jumpTo]);
  useEffect(() => { // jump after reload around
    if (state?.jumpTo && state.loadedInitial && !didInitial.current) { /* handled by initial layout effect */ }
  }, [state?.jumpTo, state?.loadedInitial]);

  const toPresent = async () => {
    if (state?.hasMoreNewer) { didInitial.current = false; store().clearChannel(cid); await load(); return; }
    scrollToEnd(true); setNewBelow(0);
  };

  if (!state || (!state.loadedInitial && state.loading)) return <Skeleton />;
  if (state.error && !state.loadedInitial) return <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted"><p>Couldn’t load messages: {state.error}</p><button className="btn btn-primary" onClick={() => load()}>{t('Retry')}</button></div>;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="scroller min-h-0 flex-1 overflow-x-hidden" role="log" aria-live="polite" aria-label={`Messages in ${channel.name ?? 'conversation'}`} tabIndex={0} data-testid="message-scroller">
        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {state.loading && state.list.length > 0 && <div className="absolute inset-x-0 top-0 z-10 flex justify-center py-2"><Spinner /></div>}
          {virt.getVirtualItems().map((v) => {
            const r = rows[v.index]; if (!r) return null;
            return (
              <div key={v.key} data-index={v.index} ref={virt.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}>
                <RowView r={r} channel={channel} flashId={flashId} />
              </div>
            );
          })}
        </div>
        <div className="h-4" />
      </div>
      {(showJump || newBelow > 0) && (
        <button onClick={toPresent} className={cx('absolute inset-x-4 bottom-2 z-10 flex items-center justify-between rounded-md px-3 py-1.5 text-sm font-semibold text-white shadow-high', newBelow > 0 ? 'bg-brand' : 'bg-[rgb(var(--float))] text-header')}>
          <span>{newBelow > 0 ? `${newBelow} new message${newBelow > 1 ? 's' : ''}` : 'You’re viewing older messages'}</span><span className="flex items-center gap-1">Jump To Present <ArrowDown size={14} /></span>
        </button>
      )}
    </div>
  );
}

function RowView({ r, channel, flashId }: { r: Row; channel: Channel; flashId: string | null }) {
  const pend = useMessages((s) => (r.kind === 'pending' ? s.pending.find((p) => p.nonce === r.nonce) : undefined));
  switch (r.kind) {
    case 'date': return <div role="separator" className="relative mx-4 mb-2 mt-6 flex items-center justify-center border-t border-divider text-xs font-semibold text-muted"><span className="-mt-px bg-chat px-2 leading-none" style={{ transform: 'translateY(-50%)' }}>{r.label}</span></div>;
    case 'new': return <div role="separator" className="relative mx-4 my-1 flex items-center border-t border-danger"><span className="absolute -top-2 end-0 rounded-sm bg-danger px-1 text-[10px] font-bold uppercase leading-4 text-white">{t('New')}</span></div>;
    case 'intro': return <Intro channel={channel} />;
    case 'pending': return pend ? <PendingItem p={pend} grouped={r.grouped} /> : null;
    case 'msg': return <MessageItem m={r.m} grouped={r.grouped} highlighted={flashId === r.m.id} />;
  }
}

function Intro({ channel }: { channel: Channel }) {
  const me = useData((s) => s.me);
  const isDm = channel.type === 'dm' || channel.type === 'group_dm';
  return (
    <div className="px-4 pb-4 pt-8">
      <div className="mb-2 flex h-[68px] w-[68px] items-center justify-center rounded-full bg-[rgb(var(--active))] text-header">{isDm ? <Users size={40} /> : <Hash size={40} />}</div>
      <h1 className="text-[32px] font-bold leading-10 text-header">{isDm ? dmName(channel, me?.id) : `Welcome to #${channel.name}!`}</h1>
      <p className="text-muted">{isDm ? `This is the beginning of your direct message history with ${dmName(channel, me?.id)}.` : `This is the start of the #${channel.name} channel.${channel.topic ? ' ' + toPlain(parseInline(channel.topic)) : ''}`}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex-1 overflow-hidden px-4 pt-6" aria-busy aria-label={t('Loading messages')}>
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="mb-6 flex gap-4"><div className="skeleton h-10 w-10 shrink-0 !rounded-full" /><div className="flex-1 space-y-2"><div className="skeleton h-3.5" style={{ width: 90 + ((i * 37) % 80) }} /><div className="skeleton h-3.5" style={{ width: `${40 + ((i * 53) % 50)}%` }} />{i % 3 === 0 && <div className="skeleton h-3.5 w-1/3" />}</div></div>
      ))}
    </div>
  );
}
void useUI;
