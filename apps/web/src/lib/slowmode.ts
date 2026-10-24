import { Perm, has, snowflakeTime } from '@jorcord/shared';

/** Roles that skip slowmode: the server checks BYPASS_SLOWMODE (administrators included); channel/message managers see no countdown either. */
export const bypassesSlowmode = (perms: bigint) => has(perms, Perm.BYPASS_SLOWMODE) || has(perms, Perm.MANAGE_CHANNELS) || has(perms, Perm.MANAGE_MESSAGES);

/**
 * Whole seconds the sender still has to wait before posting again, or 0.
 * `lastOwnMessageId` is the newest message of mine in the channel (snowflake -> timestamp); `until` is a client-known deadline
 * (set after a send or from a 429 `retry_after`). The larger of the two wins.
 */
export function slowmodeRemaining(o: { slowmode: number; lastOwnMessageId?: string | null; until?: number; now?: number; bypass?: boolean }): number {
  if (!o.slowmode || o.slowmode <= 0 || o.bypass) return 0;
  const now = o.now ?? Date.now();
  const fromMsg = o.lastOwnMessageId ? snowflakeTime(o.lastOwnMessageId) + o.slowmode * 1000 : 0;
  const deadline = Math.max(fromMsg, o.until ?? 0);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** "1:05" / "42s" label for the countdown. */
export const fmtSlowmode = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`);
