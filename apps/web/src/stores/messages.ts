import { create } from 'zustand';
import type { AllowedMentions, Id, Message, Reaction } from '@jorcord/shared';
import { compareId } from '@/lib/format';
import { applyPollVote, mergePollKeepingMine } from '@/lib/polls';

/** Ephemeral replies (flags & 64) exist only in the client: never refetched, so they must survive a channel reload. */
export const isEphemeral = (m: Pick<Message, 'flags'>) => ((m.flags ?? 0) & 64) !== 0;

export interface ChannelMsgs {
  initSeq?: number; // bumped on every (re)initialisation so views can re-position
  list: Message[]; // ascending by id
  loading: boolean; loadedInitial: boolean; hasMoreOlder: boolean; hasMoreNewer: boolean; error?: string; jumpTo?: Id | null;
}
export interface Pending { nonce: string; channelId: Id; content: string; files: { name: string; size: number }[]; replyTo: Id | null; allowedMentions?: AllowedMentions | null; status: 'sending' | 'failed'; progress?: number; createdAt: number }
interface MsgState {
  ch: Record<Id, ChannelMsgs>; pending: Pending[];
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
const merge = (a: Message[], b: Message[]) => { const m = new Map<Id, Message>(); for (const x of a) m.set(x.id, x); for (const x of b) m.set(x.id, x); return asc([...m.values()]); };

export const useMessages = create<MsgState>((set) => {
  const patch = (cid: Id, fn: (c: ChannelMsgs) => Partial<ChannelMsgs>) => set((s) => ({ ch: { ...s.ch, [cid]: { ...(s.ch[cid] ?? blank()), ...fn(s.ch[cid] ?? blank()) } } }));
  return {
    ch: {}, pending: [],
    init: (cid, nf, limit, around) => patch(cid, (c) => ({ initSeq: (c.initSeq ?? 0) + 1, list: asc([...nf, ...c.list.filter(isEphemeral)]), loading: false, loadedInitial: true, hasMoreOlder: nf.length >= limit || !!around, hasMoreNewer: !!around, error: undefined, jumpTo: around ?? null })),
    prepend: (cid, nf, limit) => patch(cid, (c) => ({ list: merge(nf, c.list), loading: false, hasMoreOlder: nf.length >= limit })),
    append: (cid, nf, limit) => patch(cid, (c) => ({ list: merge(c.list, nf), loading: false, hasMoreNewer: nf.length >= limit })),
    setLoading: (cid, loading, error) => patch(cid, () => ({ loading, error })),
    upsert: (m) => patch(m.channelId, (c) => {
      const i = c.list.findIndex((x) => x.id === m.id);
      if (i >= 0) { const l = c.list.slice(); l[i] = m; return { list: l }; }
      if (c.hasMoreNewer) return {};
      return { list: [...c.list, m] };
    }),
    update: (m) => patch(m.channelId, (c) => ({ list: c.list.map((x) => (x.id === m.id ? { ...x, ...m, ...(m.poll ? { poll: mergePollKeepingMine(m.poll, x.poll) } : {}) } : x)) })),
    replace: (m) => patch(m.channelId, (c) => ({ list: c.list.map((x) => (x.id === m.id ? { ...x, ...m } : x)) })),
    pollVote: (cid, mid, answerId, delta, mine) => patch(cid, (c) => ({ list: c.list.map((x) => (x.id === mid && x.poll ? { ...x, poll: applyPollVote(x.poll, answerId, delta, mine) } : x)) })),
    remove: (cid, id) => patch(cid, (c) => ({ list: c.list.filter((x) => x.id !== id) })),
    reaction: (cid, mid, emoji, emojiId, delta, mine, burst = false, burstColor: string | null = null) => patch(cid, (c) => ({
      list: c.list.map((m) => {
        if (m.id !== mid) return m;
        const rs: Reaction[] = m.reactions.slice();
        const i = rs.findIndex((r) => r.emoji === emoji && r.emojiId === emojiId);
        if (i < 0) {
          if (delta > 0) rs.push(burst
            ? { emoji, emojiId, count: 0, me: false, burstCount: 1, meBurst: mine, burstColors: burstColor ? [burstColor] : [] }
            : { emoji, emojiId, count: 1, me: mine });
        } else if (burst) {
          const r = rs[i]!; const burstCount = Math.max(0, (r.burstCount ?? 0) + delta);
          if (burstCount === 0 && r.count === 0) rs.splice(i, 1);
          else rs[i] = { ...r, burstCount, meBurst: mine ? delta > 0 : !!r.meBurst, burstColors: r.burstColors?.length ? r.burstColors : (burstColor ? [burstColor] : []) };
        } else {
          const r = rs[i]!; const count = Math.max(0, r.count + delta);
          if (count === 0 && !r.burstCount) rs.splice(i, 1);
          else rs[i] = { ...r, count, me: mine ? delta > 0 : r.me };
        }
        return { ...m, reactions: rs };
      }),
    })),
    addPending: (p) => set((s) => ({ pending: [...s.pending, p] })),
    patchPending: (nonce, p) => set((s) => ({ pending: s.pending.map((x) => (x.nonce === nonce ? { ...x, ...p } : x)) })),
    dropPending: (nonce) => set((s) => ({ pending: s.pending.filter((x) => x.nonce !== nonce) })),
    clearChannel: (cid) => set((s) => { const { [cid]: _, ...rest } = s.ch; return { ch: rest }; }),
  };
});
