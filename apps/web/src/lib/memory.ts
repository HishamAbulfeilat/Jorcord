/**
 * Memory caps and pure eviction helpers. Nothing here imports a store, so the stores can use it freely.
 * "Low-memory mode" (Settings > Advanced) swaps the caps for the small set; it is per device (not synced).
 */
import type { Id } from '@jorcord/shared';

export interface MemoryCaps {
  /** Channels whose message lists stay in memory (LRU, the open ones are never evicted). */
  channels: number;
  /** Messages kept per channel; older/newer ones are dropped and re-fetched on demand. */
  messagesPerChannel: number;
  /** Cached user objects that no member list / DM / loaded message refers to. */
  users: number;
  /** Animated images (GIF/APNG/WebP) allowed to animate at the same time. */
  animatedImages: number;
}
export const NORMAL_CAPS: MemoryCaps = { channels: 12, messagesPerChannel: 400, users: 4000, animatedImages: 12 };
export const LOW_CAPS: MemoryCaps = { channels: 4, messagesPerChannel: 150, users: 1000, animatedImages: 3 };

const KEY = 'jorcord.lowMemory';
let low: boolean | null = null;
const listeners = new Set<() => void>();

export function isLowMemory(): boolean {
  if (low === null) { try { low = localStorage.getItem(KEY) === '1'; } catch { low = false; } }
  return low;
}
export function setLowMemory(v: boolean): void {
  low = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}
export function subscribeMemoryMode(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
export const getCaps = (): MemoryCaps => (isLowMemory() ? LOW_CAPS : NORMAL_CAPS);
/** Test hook. */
export function _resetMemoryMode(): void { low = null; listeners.clear(); }

/** Trim slack so a list is not re-sliced on every single new message. */
export const trimSlack = (max: number) => Math.max(10, Math.ceil(max * 0.25));

/**
 * Keeps at most `max` items of an ascending list. `drop: 'start'` removes the oldest (used while appending newer
 * pages / live messages), `drop: 'end'` removes the newest (used while paging back through history).
 * Only trims once the list exceeds `max + slack`, so it runs rarely.
 */
export function trimWindow<T>(list: T[], max: number, drop: 'start' | 'end', slack = trimSlack(max)): { list: T[]; dropped: number } {
  if (list.length <= max + slack) return { list, dropped: 0 };
  const dropped = list.length - max;
  return { list: drop === 'start' ? list.slice(dropped) : list.slice(0, max), dropped };
}

/** Channel ids to evict: oldest-used first until `max` remain. Protected ids (open, pending sends) never go. */
export function lruVictims(order: Id[], max: number, isProtected: (id: Id) => boolean): Id[] {
  const out: Id[] = [];
  let keep = order.length;
  for (const id of order) {
    if (keep <= max) break;
    if (isProtected(id)) continue;
    out.push(id); keep--;
  }
  return out;
}

/** Moves `id` to the most-recent end of an LRU list. */
export function touchLru(order: Id[], id: Id): Id[] {
  if (order[order.length - 1] === id) return order;
  return [...order.filter((x) => x !== id), id];
}

/** User ids to drop: unreferenced ones, oldest-inserted first, until at most `cap` remain. Referenced ids are never touched. */
export function userVictims(allIds: Id[], referenced: ReadonlySet<Id>, cap: number): Id[] {
  if (allIds.length <= cap) return [];
  return allIds.filter((id) => !referenced.has(id)).slice(0, allIds.length - cap);
}

/** Drops typing entries older than `ttl` ms and empty channels. Returns the same object when nothing changed. */
export function pruneTyping(typing: Record<Id, Record<Id, number>>, now: number, ttl = 10_000): Record<Id, Record<Id, number>> {
  let changed = false;
  const out: Record<Id, Record<Id, number>> = {};
  for (const [cid, users] of Object.entries(typing)) {
    const live: Record<Id, number> = {};
    let n = 0;
    for (const [uid, at] of Object.entries(users)) if (now - at < ttl) { live[uid] = at; n++; }
    if (n !== Object.keys(users).length) changed = true;
    if (n) out[cid] = live; else changed = true;
  }
  return changed ? out : typing;
}

/** Best-effort JS heap size in bytes (Chromium only), or null. */
export function heapUsed(): number | null {
  const m = typeof performance !== 'undefined' ? (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory : undefined;
  return m && typeof m.usedJSHeapSize === 'number' ? m.usedJSHeapSize : null;
}
