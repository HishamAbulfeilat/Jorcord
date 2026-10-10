import { describe, expect, it } from 'vitest';
import { FOLDER_PREFIX, applyDrop, extractGuild, layoutFromItems, mergeInto, moveGuildToFolder, moveItem, railKeys, resolveRail, type RailItem } from './railLayout';

const g = (id: string): RailItem => ({ kind: 'guild', id });
const folder = (id: string, ids: string[]): RailItem => ({ kind: 'folder', id, guildIds: ids, folder: { id, name: 'F', color: null, guildIds: ids } });
const keys = (items: RailItem[]) => railKeys(items);

describe('rail layout', () => {
  it('keeps server order, appends new guilds and drops deleted ones', () => {
    const items = resolveRail(['a', 'b', 'c', 'd'], { order: ['c', 'a', 'gone'], folders: [] });
    expect(keys(items)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('places folders in the order list and hides their guilds from the top level', () => {
    const items = resolveRail(['a', 'b', 'c'], { order: ['a', FOLDER_PREFIX + 'f', 'b'], folders: [{ id: 'f', name: 'x', color: null, guildIds: ['b', 'c'] }] });
    expect(keys(items)).toEqual(['a', 'folder:f']);
    expect((items[1] as any).guildIds).toEqual(['b', 'c']);
  });
  it('drops empty folders and ids that vanished from a folder', () => {
    const items = resolveRail(['a'], { order: [FOLDER_PREFIX + 'f', 'a'], folders: [{ id: 'f', name: '', color: null, guildIds: ['zzz'] }] });
    expect(keys(items)).toEqual(['a']);
  });
  it('a guild listed in two folders belongs to the first only', () => {
    const items = resolveRail(['a', 'b'], { order: [], folders: [{ id: '1', name: '', color: null, guildIds: ['a', 'b'] }, { id: '2', name: '', color: null, guildIds: ['b'] }] });
    expect(items.map((i) => (i.kind === 'folder' ? i.guildIds : [i.id]))).toEqual([['a', 'b']]);
  });
  it('moveItem reorders', () => { expect(keys(moveItem([g('a'), g('b'), g('c')], 'a', 'c'))).toEqual(['b', 'c', 'a']); });
  it('mergeInto creates a folder from two guilds, or joins an existing folder', () => {
    const made = mergeInto([g('a'), g('b'), g('c')], 'c', 'a', () => 'N');
    expect(keys(made)).toEqual(['folder:N', 'b']);
    expect((made[0] as any).guildIds).toEqual(['a', 'c']);
    const joined = mergeInto([folder('F', ['a', 'b']), g('c')], 'c', FOLDER_PREFIX + 'F', () => 'X');
    expect(keys(joined)).toEqual(['folder:F']);
    expect((joined[0] as any).guildIds).toEqual(['a', 'b', 'c']);
  });
  it('extractGuild lifts a guild out; the folder disappears when emptied', () => {
    expect(keys(extractGuild([folder('F', ['a', 'b'])], 'a'))).toEqual(['folder:F', 'a']);
    expect(keys(extractGuild([folder('F', ['a'])], 'a'))).toEqual(['a']);
  });
  it('moveGuildToFolder strips it from the old home', () => {
    const r = moveGuildToFolder([folder('F', ['a', 'b']), g('c')], 'c', 'F');
    expect(keys(r)).toEqual(['folder:F']);
    const r2 = moveGuildToFolder([folder('F', ['a', 'b']), folder('G', ['c'])], 'a', 'G');
    expect(r2.map((i) => (i.kind === 'folder' ? i.guildIds : [i.id]))).toEqual([['b'], ['c', 'a']]);
  });
  it('applyDrop covers top-level, in-folder and cross-container drops', () => {
    const base = [g('a'), folder('F', ['x', 'y']), g('b')];
    expect(keys(applyDrop(base, 'a', 'b'))).toEqual(['folder:F', 'b', 'a']);
    expect((applyDrop(base, 'x', 'y')[1] as any).guildIds).toEqual(['y', 'x']);
    expect(keys(applyDrop(base, 'x', 'b'))).toEqual(['a', 'folder:F', 'b', 'x']);
    expect(keys(applyDrop(base, 'a', 'x'))).toEqual(['folder:F', 'b']);
    expect(keys(applyDrop(base, 'folder:F', 'a'))).toEqual(['folder:F', 'a', 'b']);
    expect(applyDrop(base, 'a', 'a')).toBe(base);
  });
  it('layoutFromItems round-trips through resolveRail', () => {
    const items = [g('a'), folder('F', ['x', 'y']), g('b')];
    expect(keys(resolveRail(['a', 'x', 'y', 'b'], layoutFromItems(items)))).toEqual(keys(items));
  });
});
