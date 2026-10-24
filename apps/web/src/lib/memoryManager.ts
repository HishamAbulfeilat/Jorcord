/**
 * Long-session housekeeping. The stores cap themselves where they grow (messages: LRU + window trim); this module
 * handles the maps that grow as a side effect of traffic (users seen in messages, presences, activities, typing),
 * and backs the Settings > Advanced > "Memory & performance" panel.
 */
import type { Id } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { queryClient } from '@/lib/queryClient';
import { getCaps, heapUsed, pruneTyping, userVictims } from '@/lib/memory';

/** User ids that something still renders: me, members, DM peers, friends, voice, authors of cached messages. */
export function referencedUsers(): Set<Id> {
  const d = useData.getState(); const keep = new Set<Id>();
  if (d.me) keep.add(d.me.id);
  for (const g of Object.values(d.guilds)) for (const id of Object.keys(g.members)) keep.add(id);
  for (const c of Object.values(d.dms)) for (const r of c.recipients ?? []) keep.add(r.id);
  for (const id of Object.keys(d.relationships)) keep.add(id);
  for (const id of Object.keys(d.voiceStates)) keep.add(id);
  for (const c of Object.values(useMessages.getState().ch)) for (const m of c.list) { keep.add(m.author.id); for (const u of m.mentions ?? []) keep.add(typeof u === 'string' ? u : (u as { id: Id }).id); if (m.referenced) keep.add(m.referenced.author.id); }
  return keep;
}

export interface PassResult { usersDropped: number; presencesDropped: number; typingPruned: boolean }

/** One pruning pass: unreferenced users beyond the cap, presences/activities of users we no longer know, stale typing. */
export function runMemoryPass(now = Date.now(), force = false): PassResult {
  const d = useData.getState();
  const cap = force ? 0 : getCaps().users;
  const ids = Object.keys(d.users);
  const keep = referencedUsers();
  const victims = new Set(userVictims(ids, keep, cap));
  const typing = pruneTyping(d.typing, now);
  let presencesDropped = 0;
  const presences = { ...d.presences }; const activities = { ...d.activities };
  for (const id of Object.keys(presences)) if (!keep.has(id) && (victims.has(id) || !d.users[id])) { delete presences[id]; delete activities[id]; presencesDropped++; }
  if (!victims.size && !presencesDropped && typing === d.typing) return { usersDropped: 0, presencesDropped: 0, typingPruned: false };
  const users = { ...d.users }; for (const id of victims) delete users[id];
  useData.setState({ users, presences, activities, typing });
  return { usersDropped: victims.size, presencesDropped, typingPruned: typing !== d.typing };
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts the periodic pass (idempotent). Cheap when nothing is over a cap. */
export function startMemoryManager(everyMs = 30_000): () => void {
  if (timer) return stopMemoryManager;
  timer = setInterval(() => { try { runMemoryPass(); useMessages.getState().evict(); } catch { /* never break the app for housekeeping */ } }, everyMs);
  return stopMemoryManager;
}
export function stopMemoryManager(): void { if (timer) { clearInterval(timer); timer = null; } }

export interface MemoryStats {
  heapBytes: number | null; channelsCached: number; messagesCached: number; usersCached: number; presences: number; queries: number;
  /** Bytes used by Cache Storage + IndexedDB etc. as reported by the browser, when available. */
  storageBytes: number | null;
}
export async function memoryStats(): Promise<MemoryStats> {
  const d = useData.getState(); const m = useMessages.getState();
  let storageBytes: number | null = null;
  try { storageBytes = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { /* unsupported */ }
  return {
    heapBytes: heapUsed(), channelsCached: Object.keys(m.ch).length, messagesCached: Object.values(m.ch).reduce((n, c) => n + c.list.length, 0),
    usersCached: Object.keys(d.users).length, presences: Object.keys(d.presences).length, queries: queryClient.getQueryCache().getAll().length, storageBytes,
  };
}

/** "Clear caches": evicts unviewed channels, prunes users, drops inactive queries and the runtime image cache. */
export async function clearCaches(): Promise<void> {
  const m = useMessages.getState();
  const open = new Set(Object.entries(m.viewers).filter(([, n]) => n > 0).map(([id]) => id));
  useMessages.setState((s) => ({ ch: Object.fromEntries(Object.entries(s.ch).filter(([id]) => open.has(id))), lru: s.lru.filter((id) => open.has(id)) }));
  runMemoryPass(Date.now(), true);
  queryClient.removeQueries({ type: 'inactive' });
  try { if (typeof caches !== 'undefined') for (const k of await caches.keys()) if (/images|noise/.test(k)) await caches.delete(k); } catch { /* no Cache Storage */ }
}

export const fmtMB = (b: number | null) => (b == null ? 'n/a' : `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`);
