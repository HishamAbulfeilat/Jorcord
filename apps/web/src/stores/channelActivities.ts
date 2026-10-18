import { create } from 'zustand';
import type { ChannelActivity } from '@jorcord/shared';

interface ChannelActivitiesState {
  /** Live sessions by channel, kept in sync by the ACTIVITY_START/UPDATE/END gateway events. */
  byChannel: Record<string, ChannelActivity[]>;
  setChannel(channelId: string, activities: ChannelActivity[]): void;
  upsert(activity: ChannelActivity): void;
  remove(id: string, channelId: string): void;
  reset(): void;
}

export const useChannelActivities = create<ChannelActivitiesState>((set) => ({
  byChannel: {},
  setChannel: (channelId, activities) => set((s) => ({ byChannel: { ...s.byChannel, [channelId]: activities } })),
  upsert: (activity) => set((s) => {
    const list = s.byChannel[activity.channelId] ?? [];
    const i = list.findIndex((a) => a.id === activity.id);
    const next = i === -1 ? [...list, activity] : list.map((a) => (a.id === activity.id ? activity : a));
    return { byChannel: { ...s.byChannel, [activity.channelId]: next } };
  }),
  remove: (id, channelId) => set((s) => ({ byChannel: { ...s.byChannel, [channelId]: (s.byChannel[channelId] ?? []).filter((a) => a.id !== id) } })),
  reset: () => set({ byChannel: {} }),
}));
