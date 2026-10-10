import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { Channel, Id, Onboarding } from '@jorcord/shared';
import { api } from './api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';

export interface HideRules {
  currentId?: Id | null; hideMuted: boolean; muted: Record<Id, boolean>;
  /** onboarding opt-in channels (referenced by an option, not a default) and what I chose; `chosen` null = I have not answered yet, show everything */
  optIn: Set<Id>; chosen: Set<Id> | null; browseAll: boolean;
}
/** Should a channel appear in the sidebar? The channel you are looking at always does. */
export function channelShown(c: Pick<Channel, 'id'>, r: HideRules): boolean {
  if (c.id === r.currentId) return true;
  if (r.hideMuted && r.muted[c.id]) return false;
  if (!r.browseAll && r.chosen && r.optIn.has(c.id) && !r.chosen.has(c.id)) return false;
  return true;
}
export function optInChannels(o: Pick<Onboarding, 'defaultChannelIds' | 'prompts'> | undefined): Set<Id> {
  const out = new Set<Id>(); if (!o) return out;
  const defaults = new Set(o.defaultChannelIds);
  for (const p of o.prompts) for (const op of p.options) for (const c of op.channelIds) if (!defaults.has(c)) out.add(c);
  return out;
}

/** Sidebar filters: "Hide Muted Channels" (per server, local) and onboarding opt-in channels (with a "browse all" escape hatch). */
export function useChannelHides(guildId: Id, currentId: Id | null | undefined) {
  const hasOnboarding = useData((s) => !!s.guilds[guildId]?.guild.features.includes('ONBOARDING'));
  const q = useQuery({ queryKey: ['onboarding', guildId], enabled: hasOnboarding, queryFn: () => api.guilds.onboarding(guildId), staleTime: 60_000 });
  const hideMuted = useUI((s) => !!s.prefs.hideMutedChannels[guildId]); const muted = useUI((s) => s.prefs.mutedChannels);
  const [browseAll, setBrowseAll] = useState(false);
  const optIn = useMemo(() => optInChannels(hasOnboarding ? q.data : undefined), [hasOnboarding, q.data]);
  const chosen = useMemo(() => (hasOnboarding && q.data?.responses ? new Set(q.data.responses.channelIds) : null), [hasOnboarding, q.data]);
  const filtering = optIn.size > 0 && !!chosen;
  const keep = useCallback((c: Pick<Channel, 'id'>) => channelShown(c, { currentId, hideMuted, muted, optIn, chosen, browseAll }), [currentId, hideMuted, muted, optIn, chosen, browseAll]);
  return { keep, filtering, browseAll, setBrowseAll, hasOnboarding };
}
