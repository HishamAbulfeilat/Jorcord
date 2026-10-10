/** Pure channel/category reordering used by the sidebar and the Channels settings tab. */
import type { Channel, Id } from '@jorcord/shared';

export interface ChanLayout { root: Id[]; cats: { id: Id; children: Id[] }[] }
export const CAT = 'cat:';
export const ROOT_DROP = 'root-drop';
export const catDrop = (id: Id) => `catdrop:${id}`;

export function layoutOf(uncategorized: Pick<Channel, 'id'>[], categories: { cat: Pick<Channel, 'id'>; children: Pick<Channel, 'id'>[] }[]): ChanLayout {
  return { root: uncategorized.map((c) => c.id), cats: categories.map((c) => ({ id: c.cat.id, children: c.children.map((x) => x.id) })) };
}

const clone = (l: ChanLayout): ChanLayout => ({ root: [...l.root], cats: l.cats.map((c) => ({ id: c.id, children: [...c.children] })) });
const arrMove = <T,>(a: T[], from: number, to: number) => { const x = a.slice(); const [i] = x.splice(from, 1); x.splice(to, 0, i!); return x; };

/** Where a channel id currently lives: -1 = root, n = categories[n]. */
function where(l: ChanLayout, id: Id): { c: number; i: number } | null {
  const r = l.root.indexOf(id); if (r >= 0) return { c: -1, i: r };
  for (let c = 0; c < l.cats.length; c++) { const i = l.cats[c]!.children.indexOf(id); if (i >= 0) return { c, i }; }
  return null;
}

/** Resolve a drop. `activeId` is a channel id or `cat:<id>`; `overId` a channel id, `cat:<id>`, `catdrop:<id>` or `root-drop`. */
export function applyChannelDrop(layout: ChanLayout, activeId: string, overId: string): ChanLayout {
  if (activeId === overId) return layout;
  const l = clone(layout);
  if (activeId.startsWith(CAT)) {
    const a = l.cats.findIndex((c) => CAT + c.id === activeId);
    let target = overId.startsWith(CAT) ? overId : overId.startsWith('catdrop:') ? CAT + overId.slice(8) : null;
    if (!target) { const w = where(l, overId); target = w && w.c >= 0 ? CAT + l.cats[w.c]!.id : null; }
    const b = l.cats.findIndex((c) => CAT + c.id === target);
    if (a < 0 || b < 0) return layout;
    l.cats = arrMove(l.cats, a, b); return l;
  }
  const from = where(l, activeId); if (!from) return layout;
  const bucket = (c: number) => (c < 0 ? l.root : l.cats[c]!.children);
  let to: { c: number; i: number } | null = null;
  if (overId === ROOT_DROP) to = { c: -1, i: l.root.length };
  else if (overId.startsWith('catdrop:') || overId.startsWith(CAT)) { const cid = overId.startsWith(CAT) ? overId.slice(CAT.length) : overId.slice(8); const c = l.cats.findIndex((x) => x.id === cid); if (c >= 0) to = { c, i: l.cats[c]!.children.length }; }
  else to = where(l, overId);
  if (!to) return layout;
  if (from.c === to.c) { bucket(from.c).splice(0, bucket(from.c).length, ...arrMove(bucket(from.c), from.i, Math.min(to.i, bucket(from.c).length - 1))); return l; }
  bucket(from.c).splice(from.i, 1);
  bucket(to.c).splice(Math.min(to.i, bucket(to.c).length), 0, activeId);
  return l;
}

export interface ChannelPos { id: Id; position: number; parentId: Id | null }
/** Entries for PATCH /guilds/:id/channels: only channels whose position or parent changed. */
export function orderDiff(layout: ChanLayout, current: Record<Id, Pick<Channel, 'position' | 'parentId'>>): ChannelPos[] {
  const out: ChannelPos[] = [];
  const push = (id: Id, position: number, parentId: Id | null) => { const c = current[id]; if (!c || c.position !== position || (c.parentId ?? null) !== parentId) out.push({ id, position, parentId }); };
  layout.root.forEach((id, i) => push(id, i, null));
  layout.cats.forEach((cat, ci) => { push(cat.id, ci, null); cat.children.forEach((id, i) => push(id, i, cat.id)); });
  return out;
}

/** Roles are listed highest first; reassign the existing set of positions to the new order so hierarchy stays valid. */
export function roleReorder(orderedDesc: { id: Id; position: number }[], from: number, to: number): { id: Id; position: number }[] {
  const positions = orderedDesc.map((r) => r.position).sort((a, b) => b - a);
  const moved = arrMove(orderedDesc, from, to);
  return moved.map((r, i) => ({ id: r.id, position: positions[i]! })).filter((r, i) => orderedDesc.find((o) => o.id === r.id)!.position !== r.position);
}

/** dnd-kit's default attributes make the wrapper `role=button tabIndex=0`, which hijacks accessible names; keep only the harmless ones. */
export function plainAttrs(attrs: Record<string, any>): Record<string, any> {
  const { role: _r, tabIndex: _t, 'aria-pressed': _p, ...rest } = attrs; void _r; void _t; void _p;
  return rest;
}
