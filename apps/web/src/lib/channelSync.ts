/** Channel helpers for permission sync with a category and slowmode choices (pure, no store access). */
import type { Channel, OverwriteDTO } from '@jorcord/shared';

export const SLOWMODES = [[0, 'Off'], [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [7200, '2h'], [21600, '6h']] as const;

/** Overwrites in a canonical order, with empty (allow 0 / deny 0) entries dropped: they change nothing. */
function canon(list: OverwriteDTO[] | undefined): string {
  return (list ?? []).filter((o) => (o.allow && o.allow !== '0') || (o.deny && o.deny !== '0'))
    .map((o) => `${o.type}:${o.id}:${o.allow || '0'}:${o.deny || '0'}`).sort().join('|');
}

/** The channel's overwrites are exactly its category's. `undefined` when there is nothing to sync with (no category, or the channel is a category / thread / DM). */
export function syncState(ch: Pick<Channel, 'type' | 'parentId' | 'overwrites'>, parent: Pick<Channel, 'type' | 'overwrites'> | undefined): boolean | undefined {
  if (!ch.parentId || !parent || parent.type !== 'category' || ch.type === 'category' || ch.type === 'thread' || ch.type === 'dm' || ch.type === 'group_dm') return undefined;
  return canon(ch.overwrites) === canon(parent.overwrites);
}
