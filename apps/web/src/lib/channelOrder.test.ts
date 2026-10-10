import { describe, expect, it } from 'vitest';
import { CAT, ROOT_DROP, applyChannelDrop, catDrop, orderDiff, roleReorder, type ChanLayout } from './channelOrder';

const L = (): ChanLayout => ({ root: ['r1', 'r2'], cats: [{ id: 'c1', children: ['a', 'b', 'c'] }, { id: 'c2', children: ['d'] }] });

describe('channel order', () => {
  it('reorders inside a category', () => { expect(applyChannelDrop(L(), 'a', 'c').cats[0]!.children).toEqual(['b', 'c', 'a']); });
  it('moves a channel to another category before the hovered channel', () => {
    const r = applyChannelDrop(L(), 'b', 'd');
    expect(r.cats[0]!.children).toEqual(['a', 'c']); expect(r.cats[1]!.children).toEqual(['b', 'd']);
  });
  it('dropping on a category header appends to it', () => {
    expect(applyChannelDrop(L(), 'a', CAT + 'c2').cats[1]!.children).toEqual(['d', 'a']);
    expect(applyChannelDrop(L(), 'a', catDrop('c2')).cats[1]!.children).toEqual(['d', 'a']);
  });
  it('moves between uncategorised and categories', () => {
    expect(applyChannelDrop(L(), 'a', ROOT_DROP).root).toEqual(['r1', 'r2', 'a']);
    expect(applyChannelDrop(L(), 'r1', 'b').cats[0]!.children).toEqual(['a', 'r1', 'b', 'c']);
  });
  it('reorders categories, including by hovering one of their channels', () => {
    expect(applyChannelDrop(L(), CAT + 'c1', CAT + 'c2').cats.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(applyChannelDrop(L(), CAT + 'c2', 'a').cats.map((c) => c.id)).toEqual(['c2', 'c1']);
  });
  it('returns the same object for no-ops and unknown ids', () => {
    const l = L(); expect(applyChannelDrop(l, 'a', 'a')).toBe(l); expect(applyChannelDrop(l, 'nope', 'a')).toBe(l);
  });
  it('orderDiff only lists channels that changed position or parent', () => {
    const cur = { r1: { position: 0, parentId: null }, r2: { position: 1, parentId: null }, c1: { position: 0, parentId: null }, c2: { position: 1, parentId: null }, a: { position: 0, parentId: 'c1' }, b: { position: 1, parentId: 'c1' }, c: { position: 2, parentId: 'c1' }, d: { position: 0, parentId: 'c2' } };
    expect(orderDiff(L(), cur)).toEqual([]);
    const diff = orderDiff(applyChannelDrop(L(), 'b', 'd'), cur);
    expect(diff).toEqual([{ id: 'c', position: 1, parentId: 'c1' }, { id: 'b', position: 0, parentId: 'c2' }, { id: 'd', position: 1, parentId: 'c2' }]);
  });
  it('roleReorder keeps the multiset of positions and emits only changes', () => {
    const roles = [{ id: 'a', position: 9 }, { id: 'b', position: 5 }, { id: 'c', position: 2 }];
    expect(roleReorder(roles, 2, 0)).toEqual([{ id: 'c', position: 9 }, { id: 'a', position: 5 }, { id: 'b', position: 2 }]);
    expect(roleReorder(roles, 1, 1)).toEqual([]);
  });
});

import { plainAttrs } from './channelOrder';
describe('plainAttrs', () => {
  it('drops attributes that would hijack the row for assistive tech', () => {
    expect(plainAttrs({ role: 'button', tabIndex: 0, 'aria-pressed': false, 'aria-disabled': true, 'aria-roledescription': 'sortable', 'aria-describedby': 'x' })).toEqual({ 'aria-describedby': 'x' });
  });
});
