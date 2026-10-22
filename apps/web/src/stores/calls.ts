import { create } from 'zustand';
import type { CallRing, CallRingEndReason, Id } from '@jorcord/shared';

/** Incoming DM / group-DM calls that are ringing for me, keyed by channel. `ignored` = dismissed locally (silent, no modal). */
export interface IncomingCall extends CallRing { ignored: boolean }

interface CallsState {
  rings: Record<Id, IncomingCall>;
  /** Replace everything (READY after a reconnect). Expired rings are dropped. */
  setAll(rings: CallRing[], now?: number): void;
  ring(r: CallRing): void;
  /** CALL_RING_END, or the user answering / declining here. `callId` guards against ending a newer ring of the same channel. */
  end(channelId: Id, callId?: Id): void;
  ignore(channelId: Id): void;
  expire(now?: number): void;
}

export const useCalls = create<CallsState>((set) => ({
  rings: {},
  setAll: (list, now = Date.now()) => set({ rings: Object.fromEntries(list.filter((r) => Date.parse(r.expiresAt) > now).map((r) => [r.channelId, { ...r, ignored: false }])) }),
  ring: (r) => set((s) => ({ rings: { ...s.rings, [r.channelId]: { ...r, ignored: s.rings[r.channelId]?.callId === r.callId ? s.rings[r.channelId]!.ignored : false } } })),
  end: (channelId, callId) => set((s) => {
    const cur = s.rings[channelId];
    if (!cur || (callId && cur.callId !== callId)) return s;
    const { [channelId]: _gone, ...rest } = s.rings; void _gone;
    return { rings: rest };
  }),
  ignore: (channelId) => set((s) => (s.rings[channelId] ? { rings: { ...s.rings, [channelId]: { ...s.rings[channelId]!, ignored: true } } } : s)),
  expire: (now = Date.now()) => set((s) => {
    const keep = Object.entries(s.rings).filter(([, r]) => Date.parse(r.expiresAt) > now);
    return keep.length === Object.keys(s.rings).length ? s : { rings: Object.fromEntries(keep) };
  }),
}));

export const wireCallEvents = {
  ring: (r: CallRing) => useCalls.getState().ring(r),
  end: (d: { channelId: Id; callId: Id; reason: CallRingEndReason }) => useCalls.getState().end(d.channelId, d.callId),
};

/** The ring that should be on screen / audible: the newest un-ignored one. */
export function activeRing(rings: Record<Id, IncomingCall>): IncomingCall | null {
  const live = Object.values(rings).filter((r) => !r.ignored).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return live[0] ?? null;
}
