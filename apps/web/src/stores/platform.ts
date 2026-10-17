/** Client state for the platform pass: scheduled events, stage instances, in-flight interactions and autocomplete answers. */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { CommandOptionChoice, Id, ScheduledEvent, StageInstance } from '@jorcord/shared';
import { applyInterest, isUpcoming } from '@/lib/events';
import { api } from '@/lib/api';

export interface PendingInteraction { id: Id; channelId: Id; kind: 'command' | 'component' | 'modal' | 'autocomplete'; name?: string; applicationId?: Id; at: number; messageId?: Id; customId?: string }

interface PlatformState {
  events: Record<Id, Record<Id, ScheduledEvent>>; eventsLoaded: Record<Id, boolean>;
  stages: Record<Id, StageInstance>; stagesLoaded: Record<Id, boolean>;
  interactions: Record<Id, PendingInteraction>;
  /** component presses awaiting any answer, keyed `messageId:customId` (drives the spinner on a button) */
  busy: Record<string, number>;
  autocomplete: Record<Id, CommandOptionChoice[]>;
  /** applications seen in command catalogs: application id -> its bot user (for "did not respond" notices) */
  apps: Record<Id, { name: string; icon: string | null; botUserId: Id }>;
  setApps(list: { id: Id; name: string; icon: string | null; botUserId: Id }[]): void;
  setEvents(guildId: Id, list: ScheduledEvent[]): void;
  upsertEvent(e: ScheduledEvent): void;
  removeEvent(e: Pick<ScheduledEvent, 'id' | 'guildId'>): void;
  eventInterest(guildId: Id, eid: Id, delta: 1 | -1, mine: boolean): void;
  setStages(guildId: Id, list: StageInstance[], channelIds?: Id[]): void;
  setStage(s: StageInstance): void;
  removeStage(channelId: Id): void;
  track(i: PendingInteraction): void;
  settle(id: Id): PendingInteraction | undefined;
  setBusy(key: string, on: boolean): void;
  setAutocomplete(id: Id, choices: CommandOptionChoice[]): void;
  reset(): void;
}

const empty = { events: {}, eventsLoaded: {}, stages: {}, stagesLoaded: {}, interactions: {}, busy: {}, autocomplete: {}, apps: {} };

export const usePlatform = create<PlatformState>((set, get) => ({
  ...empty,
  reset: () => set({ ...empty }),
  setEvents: (guildId, list) => set((s) => ({ events: { ...s.events, [guildId]: Object.fromEntries(list.map((e) => [e.id, e])) }, eventsLoaded: { ...s.eventsLoaded, [guildId]: true } })),
  upsertEvent: (e) => set((s) => {
    const cur = { ...(s.events[e.guildId] ?? {}) };
    if (isUpcoming(e)) cur[e.id] = { ...cur[e.id], ...e, interested: e.interested ?? cur[e.id]?.interested }; else delete cur[e.id]; // completed/canceled leave the list
    return { events: { ...s.events, [e.guildId]: cur } };
  }),
  removeEvent: (e) => set((s) => { const cur = { ...(s.events[e.guildId] ?? {}) }; delete cur[e.id]; return { events: { ...s.events, [e.guildId]: cur } }; }),
  eventInterest: (guildId, eid, delta, mine) => set((s) => {
    const e = s.events[guildId]?.[eid]; if (!e) return s;
    if (mine && !!e.interested === (delta > 0)) return s; // already applied (optimistic toggle + gateway echo)
    return { events: { ...s.events, [guildId]: { ...s.events[guildId], [eid]: applyInterest(e, delta, mine) } } };
  }),
  setStages: (guildId, list, channelIds) => set((s) => {
    const stages = { ...s.stages };
    for (const c of channelIds ?? []) delete stages[c];
    for (const st of list) stages[st.channelId] = st;
    return { stages, stagesLoaded: { ...s.stagesLoaded, [guildId]: true } };
  }),
  setStage: (st) => set((s) => ({ stages: { ...s.stages, [st.channelId]: st } })),
  removeStage: (channelId) => set((s) => { const { [channelId]: _, ...rest } = s.stages; return { stages: rest }; }),
  track: (i) => {
    set((s) => ({ interactions: { ...s.interactions, [i.id]: i }, busy: i.kind === 'component' && i.messageId && i.customId ? { ...s.busy, [`${i.messageId}:${i.customId}`]: i.at } : s.busy }));
    // No event follows a silently acknowledged press (deferred update), so stop the spinner when the 3s acknowledge window is over
    // (a failure would already have arrived as INTERACTION_FAILED). Everything is forgotten after 15s.
    if (i.kind === 'component') setTimeout(() => get().settle(i.id), 3500);
    setTimeout(() => get().settle(i.id), 15_000);
  },
  settle: (id) => {
    const i = get().interactions[id]; if (!i) return undefined;
    set((s) => {
      const { [id]: _, ...interactions } = s.interactions;
      let busy = s.busy; if (i.messageId && i.customId) { const { [`${i.messageId}:${i.customId}`]: __, ...rest } = busy; busy = rest; }
      return { interactions, busy };
    });
    return i;
  },
  setBusy: (key, on) => set((s) => { if (on) return { busy: { ...s.busy, [key]: Date.now() } }; const { [key]: _, ...rest } = s.busy; return { busy: rest }; }),
  setApps: (list) => set((s) => ({ apps: { ...s.apps, ...Object.fromEntries(list.map((a) => [a.id, { name: a.name, icon: a.icon, botUserId: a.botUserId }])) } })),
  setAutocomplete: (id, choices) => set((s) => ({ autocomplete: { ...s.autocomplete, [id]: choices } })),
}));

/** Fetch a guild's scheduled events once; shared by the sidebar, the events modal and the event editor. */
export function useLoadEvents(guildId: string | undefined) {
  const loaded = usePlatform((s) => (guildId ? !!s.eventsLoaded[guildId] : true));
  useEffect(() => {
    if (!guildId || loaded) return;
    usePlatform.setState((s) => ({ eventsLoaded: { ...s.eventsLoaded, [guildId]: true } })); // claim first so StrictMode / siblings do not double-fetch
    api.guilds.events(guildId).then((l) => usePlatform.getState().setEvents(guildId, l)).catch(() => usePlatform.setState((s) => ({ eventsLoaded: { ...s.eventsLoaded, [guildId]: false } })));
  }, [guildId, loaded]);
}

export const guildEvents = (s: Pick<PlatformState, 'events'>, guildId: Id): ScheduledEvent[] => Object.values(s.events[guildId] ?? {});
