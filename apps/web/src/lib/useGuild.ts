import { useMemo } from 'react';
import type { Channel, Id } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { effectivePerms, can } from './perms';
import { useShallow } from 'zustand/react/shallow';

export function useGuildPerms(guildId: Id | undefined, channel?: Channel): bigint {
  const g = useData((s) => (guildId ? s.guilds[guildId] : undefined));
  const me = useData((s) => (guildId && s.me ? s.guilds[guildId]?.members[s.me.id] : undefined));
  return useMemo(() => (g && me ? effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me }, channel) : 0n), [g?.guild, g?.roles, me, channel]);
}
export function useDmPerms(): bigint { return (1n << 41n) - 1n; }

/** Channels the user may view, grouped for the sidebar. */
export function useSidebarChannels(guildId: Id) {
  const g = useData((s) => s.guilds[guildId]);
  const me = useData((s) => (s.me ? s.guilds[guildId]?.members[s.me.id] : undefined));
  return useMemo(() => {
    if (!g || !me) return { uncategorized: [] as Channel[], categories: [] as { cat: Channel; children: Channel[] }[] };
    const roles = Object.values(g.roles);
    const visible = (c: Channel) => can(effectivePerms({ guild: g.guild, roles, member: me }, c), Perm.VIEW_CHANNEL);
    const all = Object.values(g.channels).filter((c) => c.type !== 'thread');
    const cats = all.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
    const rank = (c: Channel) => (c.type === 'voice' || c.type === 'stage' ? 1 : 0);
    const kids = (pid: string | null) => all.filter((c) => c.type !== 'category' && c.parentId === pid && visible(c)).sort((a, b) => rank(a) - rank(b) || a.position - b.position);
    return {
      uncategorized: kids(null),
      categories: cats.map((cat) => ({ cat, children: kids(cat.id) })).filter((x) => x.children.length || can(effectivePerms({ guild: g.guild, roles, member: me }, x.cat), Perm.MANAGE_CHANNELS) || true),
    };
  }, [g?.channels, g?.roles, g?.guild, me]);
}
export const useFirstTextChannel = (guildId: Id | undefined) => {
  const { uncategorized, categories } = useSidebarChannels(guildId ?? '');
  return useMemo(() => [...uncategorized, ...categories.flatMap((c) => c.children)].find((c) => c.type === 'text' || c.type === 'announcement' || c.type === 'forum' || c.type === 'media'), [uncategorized, categories]);
};
void useShallow;
