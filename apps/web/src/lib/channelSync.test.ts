import { describe, expect, it } from 'vitest';
import type { OverwriteDTO } from '@jorcord/shared';
import { PERMISSION_META } from './perms';
import { syncState } from './channelSync';

const ow = (id: string, allow: string, deny: string, type: 'role' | 'member' = 'role'): OverwriteDTO => ({ id, type, allow, deny });

describe('syncState', () => {
  const cat = { type: 'category' as const, overwrites: [ow('r1', '0', '1024'), ow('r2', '2048', '0')] };
  it('is true when the overwrites match regardless of order, ignoring empty entries', () => {
    expect(syncState({ type: 'text', parentId: 'c', overwrites: [ow('r2', '2048', '0'), ow('r1', '0', '1024'), ow('r9', '0', '0')] }, cat)).toBe(true);
  });
  it('is false when anything differs', () => {
    expect(syncState({ type: 'text', parentId: 'c', overwrites: [ow('r1', '0', '1024')] }, cat)).toBe(false);
    expect(syncState({ type: 'voice', parentId: 'c', overwrites: [ow('r1', '0', '1024'), ow('r2', '2048', '1')] }, cat)).toBe(false);
    expect(syncState({ type: 'text', parentId: 'c', overwrites: [...cat.overwrites, ow('u1', '1', '0', 'member')] }, cat)).toBe(false);
  });
  it('is undefined when there is nothing to sync with', () => {
    expect(syncState({ type: 'text', parentId: null, overwrites: [] }, undefined)).toBeUndefined();
    expect(syncState({ type: 'category', parentId: null, overwrites: [] }, cat)).toBeUndefined();
    expect(syncState({ type: 'thread', parentId: 'c', overwrites: [] }, cat)).toBeUndefined();
    expect(syncState({ type: 'text', parentId: 'c', overwrites: [] }, { type: 'text', overwrites: [] })).toBeUndefined();
  });
});

describe('role editor metadata for the new bits', () => {
  it('lists every new permission with a label and description', () => {
    for (const n of ['SET_VOICE_CHANNEL_STATUS', 'USE_EXTERNAL_SOUNDS', 'CREATE_GUILD_EXPRESSIONS', 'VIEW_GUILD_INSIGHTS', 'USE_EMBEDDED_ACTIVITIES'] as const) {
      const m = PERMISSION_META.find((p) => p.name === n);
      expect(m, n).toBeTruthy(); expect(m!.label.length).toBeGreaterThan(3); expect(m!.desc.length).toBeGreaterThan(10);
    }
  });
});
