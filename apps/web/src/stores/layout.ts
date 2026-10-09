/** Per-user UI layout that follows the account: server-rail order + folders, onboarding/rules acknowledgements, status expiry. */
import { create } from 'zustand';
import { snowflake, type Id } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { layoutFromItems, mergeInto, moveGuildToFolder, extractGuild, moveItem, reorderWithin, resolveRail, type Folder, type RailItem, type RailLayout } from '@/lib/railLayout';

export interface LayoutState extends RailLayout {
  updatedAt: number;
  /** guilds whose welcome/rules screen has been completed. */
  onboarded: Record<Id, number>;
  openFolders: Record<string, boolean>;
  statusExpiresAt: number | null;
  hydrateFromServer(settings: Record<string, unknown> | undefined): void;
  items(): RailItem[];
  commit(items: RailItem[]): void;
  reorder(from: string, to: string): void;
  reorderInFolder(folderId: string, from: Id, to: Id): void;
  mergeGuilds(gid: Id, target: string): void;
  moveToFolder(gid: Id, folderId: string): void;
  removeFromFolder(gid: Id): void;
  updateFolder(id: string, patch: Partial<Pick<Folder, 'name' | 'color'>>): void;
  ungroup(id: string): void;
  toggleFolder(id: string): void;
  markOnboarded(gid: Id): void;
  setStatusExpiry(at: number | null): void;
}

const KEY = 'jorcord.layout.v1';
const load = (): Partial<LayoutState> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };
const pick = (s: LayoutState) => ({ order: s.order, folders: s.folders, updatedAt: s.updatedAt, onboarded: s.onboarded, statusExpiresAt: s.statusExpiresAt });
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(s: LayoutState) {
  try { localStorage.setItem(KEY, JSON.stringify(pick(s))); } catch { /* */ }
  clearTimeout(timer);
  timer = setTimeout(() => {
    const me = useData.getState().me; if (!me) return;
    api.users.patchMe({ settings: { ...(me.settings ?? {}), layout: pick(useLayout.getState()) } })
      .then((u) => { const cur = useData.getState().me; if (cur) useData.getState().setMe({ ...cur, settings: u?.settings ?? { ...(cur.settings ?? {}), layout: pick(useLayout.getState()) } }); })
      .catch(() => { /* offline: localStorage still has it */ });
  }, 800);
}

const guildIds = () => useData.getState().guildOrder;
const base = load();

export const useLayout = create<LayoutState>((set, get) => {
  const apply = (items: RailItem[]) => { set((s) => ({ ...layoutFromItems(items), updatedAt: Date.now(), openFolders: s.openFolders })); persist(get()); };
  return {
    order: base.order ?? [], folders: base.folders ?? [], updatedAt: base.updatedAt ?? 0, onboarded: base.onboarded ?? {}, statusExpiresAt: base.statusExpiresAt ?? null, openFolders: {},
    hydrateFromServer(settings) {
      const remote = (settings as any)?.layout as Partial<LayoutState> | undefined;
      if (!remote || (remote.updatedAt ?? 0) <= get().updatedAt) return;
      set({ order: remote.order ?? [], folders: remote.folders ?? [], updatedAt: remote.updatedAt ?? 0, onboarded: { ...get().onboarded, ...(remote.onboarded ?? {}) }, statusExpiresAt: remote.statusExpiresAt ?? null });
      try { localStorage.setItem(KEY, JSON.stringify(pick(get()))); } catch { /* */ }
    },
    items: () => resolveRail(guildIds(), get()),
    commit: apply,
    reorder: (from, to) => apply(moveItem(get().items(), from, to)),
    reorderInFolder: (fid, from, to) => apply(reorderWithin(get().items(), fid, from, to)),
    mergeGuilds: (gid, target) => { const id = snowflake(); apply(mergeInto(get().items(), gid, target, () => id)); set((s) => ({ openFolders: { ...s.openFolders, [id]: true } })); },
    moveToFolder: (gid, fid) => apply(moveGuildToFolder(get().items(), gid, fid)),
    removeFromFolder: (gid) => apply(extractGuild(get().items(), gid)),
    updateFolder: (id, patch) => apply(get().items().map((i) => (i.kind === 'folder' && i.id === id ? { ...i, folder: { ...i.folder, ...patch } } : i))),
    ungroup: (id) => apply(get().items().flatMap((i): RailItem[] => (i.kind === 'folder' && i.id === id ? i.guildIds.map((g) => ({ kind: 'guild', id: g })) : [i]))),
    toggleFolder: (id) => set((s) => ({ openFolders: { ...s.openFolders, [id]: !s.openFolders[id] } })),
    markOnboarded: (gid) => { set((s) => ({ onboarded: { ...s.onboarded, [gid]: Date.now() }, updatedAt: Date.now() })); persist(get()); },
    setStatusExpiry: (at) => { set({ statusExpiresAt: at, updatedAt: Date.now() }); persist(get()); },
  };
});
