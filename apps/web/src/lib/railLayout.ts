/** Pure helpers for the server rail: per-user ordering and folders. Persisted by stores/layout.ts. */
import type { Id } from '@jorcord/shared';

export interface Folder { id: string; name: string; color: string | null; guildIds: Id[] }
export interface RailLayout { order: string[]; folders: Folder[] }
export type RailItem = { kind: 'guild'; id: Id } | { kind: 'folder'; id: string; folder: Folder; guildIds: Id[] };

export const FOLDER_PREFIX = 'folder:';
export const isFolderKey = (k: string) => k.startsWith(FOLDER_PREFIX);

/** Merge the stored layout with the live list of guild ids (new guilds append, deleted ones vanish, empty folders disappear). */
export function resolveRail(guildIds: Id[], layout: RailLayout): RailItem[] {
  const live = new Set(guildIds);
  const folders = new Map<string, Folder>();
  const inFolder = new Set<Id>();
  for (const f of layout.folders) {
    const ids = f.guildIds.filter((g) => live.has(g) && !inFolder.has(g));
    ids.forEach((g) => inFolder.add(g));
    if (ids.length) folders.set(f.id, { ...f, guildIds: ids });
  }
  const out: RailItem[] = []; const seen = new Set<string>();
  for (const k of layout.order) {
    if (seen.has(k)) continue;
    if (isFolderKey(k)) { const f = folders.get(k.slice(FOLDER_PREFIX.length)); if (f) { seen.add(k); out.push({ kind: 'folder', id: f.id, folder: f, guildIds: f.guildIds }); } }
    else if (live.has(k) && !inFolder.has(k)) { seen.add(k); out.push({ kind: 'guild', id: k }); }
  }
  for (const f of folders.values()) if (!seen.has(FOLDER_PREFIX + f.id)) out.push({ kind: 'folder', id: f.id, folder: f, guildIds: f.guildIds });
  for (const g of guildIds) if (!inFolder.has(g) && !seen.has(g)) out.push({ kind: 'guild', id: g });
  return out;
}

export const railKeys = (items: RailItem[]) => items.map((i) => (i.kind === 'guild' ? i.id : FOLDER_PREFIX + i.id));

/** Layout built from the resolved items (what the user currently sees), so ids that vanished are pruned. */
export function layoutFromItems(items: RailItem[]): RailLayout {
  return { order: railKeys(items), folders: items.flatMap((i) => (i.kind === 'folder' ? [{ ...i.folder, guildIds: i.guildIds }] : [])) };
}

export function moveItem(items: RailItem[], fromKey: string, toKey: string): RailItem[] {
  const keys = railKeys(items); const a = keys.indexOf(fromKey), b = keys.indexOf(toKey);
  if (a < 0 || b < 0 || a === b) return items;
  const next = items.slice(); const [it] = next.splice(a, 1); next.splice(b, 0, it!); return next;
}

/** Drop guild `gid` onto another top-level guild/folder `target`: creates a folder or adds to the target folder. */
export function mergeInto(items: RailItem[], gid: Id, target: string, newId: () => string): RailItem[] {
  const without = items.filter((i) => !(i.kind === 'guild' && i.id === gid));
  const out: RailItem[] = [];
  for (const i of without) {
    const key = i.kind === 'guild' ? i.id : FOLDER_PREFIX + i.id;
    if (key !== target) { out.push(i); continue; }
    if (i.kind === 'folder') { const guildIds = [...i.guildIds, gid]; out.push({ ...i, guildIds, folder: { ...i.folder, guildIds } }); }
    else { const id = newId(); const guildIds = [i.id, gid]; out.push({ kind: 'folder', id, guildIds, folder: { id, name: '', color: null, guildIds } }); }
  }
  return out;
}

/** Take a guild out of its folder and place it right after that folder. */
export function extractGuild(items: RailItem[], gid: Id): RailItem[] {
  const out: RailItem[] = [];
  for (const i of items) {
    if (i.kind === 'folder' && i.guildIds.includes(gid)) {
      const guildIds = i.guildIds.filter((g) => g !== gid);
      if (guildIds.length) out.push({ ...i, guildIds, folder: { ...i.folder, guildIds } });
      out.push({ kind: 'guild', id: gid });
    } else out.push(i);
  }
  return out;
}

/** Move a guild into the given folder (or create one when `folderId` is null with a second guild). */
export function moveGuildToFolder(items: RailItem[], gid: Id, folderId: string): RailItem[] {
  const stripped = items.map((i) => (i.kind === 'folder' ? { ...i, guildIds: i.guildIds.filter((g) => g !== gid), folder: { ...i.folder, guildIds: i.folder.guildIds.filter((g) => g !== gid) } } : i))
    .filter((i) => !(i.kind === 'guild' && i.id === gid)).filter((i) => i.kind !== 'folder' || i.guildIds.length);
  return stripped.map((i) => (i.kind === 'folder' && i.id === folderId ? { ...i, guildIds: [...i.guildIds, gid], folder: { ...i.folder, guildIds: [...i.guildIds, gid] } } : i));
}

export function reorderWithin(items: RailItem[], folderId: string, from: Id, to: Id): RailItem[] {
  return items.map((i) => {
    if (i.kind !== 'folder' || i.id !== folderId) return i;
    const a = i.guildIds.indexOf(from), b = i.guildIds.indexOf(to); if (a < 0 || b < 0) return i;
    const ids = i.guildIds.slice(); const [x] = ids.splice(a, 1); ids.splice(b, 0, x!);
    return { ...i, guildIds: ids, folder: { ...i.folder, guildIds: ids } };
  });
}
