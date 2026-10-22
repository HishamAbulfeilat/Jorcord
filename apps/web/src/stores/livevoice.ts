/** Stage hand queue, my place in it, and Go Live kicks: realtime state that is not part of a voice state. */
import { create } from 'zustand';
import type { Id, StageQueueEntry } from '@jorcord/shared';

export interface MyHand { raised: boolean; anonymous: boolean; position: number | null }
const kickKey = (channelId: Id, streamerId: Id) => `${channelId}:${streamerId}`;

interface LiveVoiceState {
  /** Ordered raised hands per stage channel as the gateway reports them (anonymous hands have userId null). */
  queue: Record<Id, StageQueueEntry[]>;
  /** My own hand per stage channel. */
  hand: Record<Id, MyHand>;
  /** Viewers removed from a stream, keyed `channelId:streamerId` (known to the streamer and moderators; viewers learn about themselves). */
  kicked: Record<string, Id[]>;
  setQueue(channelId: Id, queue: StageQueueEntry[]): void;
  setHand(channelId: Id, h: MyHand): void;
  setKicked(channelId: Id, streamerId: Id, userIds: Id[]): void;
  kick(channelId: Id, streamerId: Id, userId: Id, kicked: boolean): void;
  isKicked(channelId: Id, streamerId: Id, userId: Id): boolean;
  clearChannel(channelId: Id): void;
  reset(): void;
}

export const useLiveVoice = create<LiveVoiceState>((set, get) => ({
  queue: {}, hand: {}, kicked: {},
  setQueue: (channelId, queue) => set((s) => ({ queue: { ...s.queue, [channelId]: queue } })),
  setHand: (channelId, h) => set((s) => ({ hand: { ...s.hand, [channelId]: h } })),
  setKicked: (channelId, streamerId, userIds) => set((s) => ({ kicked: { ...s.kicked, [kickKey(channelId, streamerId)]: userIds } })),
  kick: (channelId, streamerId, userId, kicked) => set((s) => {
    const k = kickKey(channelId, streamerId); const cur = (s.kicked[k] ?? []).filter((u) => u !== userId);
    return { kicked: { ...s.kicked, [k]: kicked ? [...cur, userId] : cur } };
  }),
  isKicked: (channelId, streamerId, userId) => (get().kicked[kickKey(channelId, streamerId)] ?? []).includes(userId),
  clearChannel: (channelId) => set((s) => {
    const { [channelId]: _q, ...queue } = s.queue; const { [channelId]: _h, ...hand } = s.hand;
    return { queue, hand, kicked: Object.fromEntries(Object.entries(s.kicked).filter(([k]) => !k.startsWith(`${channelId}:`))) };
  }),
  reset: () => set({ queue: {}, hand: {}, kicked: {} }),
}));
