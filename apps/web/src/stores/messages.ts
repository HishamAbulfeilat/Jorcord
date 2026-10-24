import { create } from 'zustand';
import type { AllowedMentions, Id, Message, Reaction } from '@jorcord/shared';
import { compareId } from '@/lib/format';
import { applyPollVote, mergePollKeepingMine } from '@/lib/polls';
import { getCaps, lruVictims, touchLru, trimWindow } from '@/lib/memory';

/** Ephemeral replies (flags & 64) exist only in the client: never refetched, so they must survive a channel reload. */
export const isEphemeral = (m: Pick<Message, 'flags'>) => ((m.flags ?? 0) & 64) !== 0;

export interface ChannelMsgs {
  initSeq?: number; // bumped on every (re)initialisation so views can re-position
  list: Message[]; // ascending by id
  loading: boolean; loadedInitial: boolean; hasMoreOlder: boolean; hasMoreNewer: boolean; error?: string; jumpTo?: Id | null;
}
export interface Pending { nonce: string; channelId: Id; content: string; files: { name: string; size: number }[]; replyTo: Id | null; allowedMentions?: AllowedMentions | null; /** Message flags (@silent, no embeds, /tts) kept for retry. */ flags?: number; status: 'sending' | 'failed'; progress?: number; createdAt: number }
interface MsgState {
  ch: Record<Id, ChannelMsgs>; pending: Pending[];
  /** Channels with a loaded list, least recently used first. Drives LRU eviction (see lib/memory). */
  lru: Id[];
  /** Mounted MessageList count per channel: viewed channels are never evicted. */
  viewers: Record<Id, number>;
  view(channelId: Id): void; unview(channelId: Id): void;
  /** Drop loaded channels beyond the cap (oldest-used first, never viewed ones or ones with pending sends). */
  evict(): void;
  init(channelId: Id, newestFirst: Message[], limit: number, around?: Id): void;
  prepend(channelId: Id, newestFirst: Message[], limit: number): void;
  append(channelId: Id, newestFirst: Message[], limit: number): void;
  setLoading(channelId: Id, v: boolean, error?: string): void;
  upsert(m: Message, me?: Id): void;
  update(m: Message): void;
  /** Replace a message wholesale (the caller's own API response, which is exact for the viewer). */
  replace(m: Message): void;
  pollVote(channelId: Id, mid: Id, answerId: number, delta: 1 | -1, mine: boolean): void;
  remove(channelId: Id, id: Id): void;
  reaction(channelId: Id, mid: Id, emoji: string, emojiId: Id | null, delta: 1 | -1, mine: boolean, burst?: boolean, burstColor?: string | null): void;
  addPending(p: Pending): void; patchPending(nonce: string, p: Partial<Pending>): void; dropPending(nonce: string): void;
  clearChannel(channelId: Id): void;
}
const blank = (): ChannelMsgs => ({ list: [], loading: false, loadedInitial: false, hasMoreOlder: true, hasMoreNewer: false });
const asc = (xs: Message[]) => [...xs].sort((a, b) => compareId(a.id, b.id));
/** Trim a loaded list to the memory cap; `drop` says which end is far from the reader. */
const capList = (c: ChannelMsgs, drop: 'start' | 'end'): Partial<ChannelMsgs> => {
  const t = trimWindow(c.list, getCaps().messagesPerChannel, drop);
  if (!t.dropped) return {};
  return drop === 'start' ? { list: t.list, hasMoreOlder: true } : { list: t.list, hasMoreNewer: true };
};
const merge = (a: Message[], b: Message[]) => { const m = new Map<Id, Message>(); for (const x of a) m.set(x.id, x); for (const x of b) m.set(x.id, x); return asc([...m.values()]); };

export const useMessages = create<MsgState>((set, get) => {
  const patch = (cid: Id, fn: (c: ChannelMsgs) => Partial<ChannelMsgs>) => set((s) => ({ ch: { ...s.ch, [cid]: { ...(s.ch[cid] ?? blank()), ...fn(s.ch[cid] ?? blank()) } } }));
  /** Like patch, but never creates an entry: gateway events for channels nobody opened must not allocate lists. */
  const patchLoaded = (cid: Id, fn: (c: ChannelMsgs) => Partial<ChannelMsgs>) => set((s) => { const c = s.ch[cid]; return c ? { ch: { ...s.ch, [cid]: { ...c, ...fn(c) } } } : s; });
  return {
    ch: {}, pending: [], lru: [], viewers: {},
    view: (cid) => set((s) => ({ viewers: { ...s.viewers, [cid]: (s.viewers[cid] ?? 0) + 1 }, lru: touchLru(s.lru, cid) })),
    unview: (cid) => set((s) => { const n = (s.viewers[cid] ?? 0) - 1; const { [cid]: _, ...rest } = s.viewers; return { viewers: n > 0 ? { ...rest, [cid]: n } : rest }; }),
    evict: () => set((s) => {
      const pend = new Set(s.pending.map((p) => p.channelId));
      const victims = lruVictims(s.lru.filter((id) => s.ch[id]), getCaps().channels, (id) => !!s.viewers[id] || pend.has(id) || !!s.ch[id]?.list.some(isEphemeral));
      if (!victims.length) return s;
      const ch = { ...s.ch }; for (const v of victims) delete ch[v];
      return { ch, lru: s.lru.filter((id) => !victims.includes(id)) };
    }),
    init: (cid, nf, limit, around) => { patch(cid, (c) => ({ initSeq: (c.initSeq ?? 0) + 1, list: asc([...nf, ...c.list.filter(isEphemeral)]), loading: false, loadedInitial: true, hasMoreOlder: nf.length >= limit || !!around, hasMoreNewer: !!around, error: undefined, jumpTo: around ?? null }));
      set((s) => ({ lru: touchLru(s.lru, cid) })); get().evict(); },
    // paging back through history: the newest end is far from the reader
    prepend: (cid, nf, limit) => patch(cid, (c) => { const o = { list: merge(nf, c.list), loading: false, hasMoreOlder: nf.length >= limit }; return { ...o, ...capList({ ...c, ...o }, 'end') }; }),
    // paging forward: the oldest end is far from the reader
    append: (cid, nf, limit) => patch(cid, (c) => { const o = { list: merge(c.list, nf), loading: false, hasMoreNewer: nf.length >= limit }; return { ...o, ...capList({ ...c, ...o }, 'start') }; }),
    setLoading: (cid, loading, error) => patch(cid, () => ({ loading, error })),
    // ephemeral replies are client-only, so they may open a list the channel load will later keep; everything else needs a loaded channel
    upsert: (m) => (isEphemeral(m) ? patch : patchLoaded)(m.channelId, (c) => {
      const i = c.list.findIndex((x) => x.id === m.id);
      if (i >= 0) { const l = c.list.slice(); l[i] = m; return { list: l }; }
      if (c.hasMoreNewer) return {};
      const list = [...c.list, m];
      return { list, ...capList({ ...c, list }, 'start') };
    }),
    update: (m) => patchLoaded(m.channelId, (c) => ({ list: c.list.map((x) => (x.id === m.id ? { ...x, ...m, ...(m.poll ? { poll: mergePollKeepingMine(m.poll, x.poll) } : {}) } : x)) })),
    replace: (m) => patchLoaded(m.channelId, (c) => ({ list: c.list.map((x) => (x.id === m.id ? { ...x, ...m } : x)) })),
    pollVote: (cid, mid, answerId, delta, mine) => patchLoaded(cid, (c) => ({ list: c.list.map((x) => (x.id === mid && x.poll ? { ...x, poll: applyPollVote(x.poll, answerId, delta, mine) } : x)) })),
    remove: (cid, id) => patchLoaded(cid, (c) => ({ list: c.list.filter((x) => x.id !== id) })),
    reaction: (cid, mid, emoji, emojiId, delta, mine, burst = false, burstColor: string | null = null) => patchLoaded(cid, (c) => ({
      list: c.list.map((m) => {
        if (m.id !== mid) return m;
        const rs: Reaction[] = m.reactions.slice();
        const i = rs.findIndex((r) => r.emoji === emoji && r.emojiId === emojiId);
        if (i < 0) {
          if (delta > 0) rs.push(burst
            ? { emoji, emojiId, count: 0, me: false, burstCount: 1, meBurst: mine, burstColors: burstColor ? [burstColor] : [] }
            : { emoji, emojiId, count: 1, me: mine });
        } else if (burst) {
          const r = rs[i]!;
          // the gateway echoes my own optimistic change back: applying it twice would double-count
          if (mine && (delta > 0 ? !!r.meBurst : !r.meBurst)) return m;
          const burstCount = Math.max(0, (r.burstCount ?? 0) + delta);
          if (burstCount === 0 && r.count === 0) rs.splice(i, 1);
          else rs[i] = { ...r, burstCount, meBurst: mine ? delta > 0 : !!r.meBurst, burstColors: r.burstColors?.length ? r.burstColors : (burstColor ? [burstColor] : []) };
        } else {
          const r = rs[i]!;
          if (mine && (delta > 0 ? r.me : !r.me)) return m;
          const count = Math.max(0, r.count + delta);
          if (count === 0 && !r.burstCount) rs.splice(i, 1);
          else rs[i] = { ...r, count, me: mine ? delta > 0 : r.me };
        }
        return { ...m, reactions: rs };
      }),
    })),
    addPending: (p) => set((s) => ({ pending: [...s.pending, p] })),
    patchPending: (nonce, p) => set((s) => ({ pending: s.pending.map((x) => (x.nonce === nonce ? { ...x, ...p } : x)) })),
    dropPending: (nonce) => set((s) => ({ pending: s.pending.filter((x) => x.nonce !== nonce) })),
    clearChannel: (cid) => set((s) => { const { [cid]: _, ...rest } = s.ch; return { ch: rest, lru: s.lru.filter((x) => x !== cid) }; }),
  };
});
