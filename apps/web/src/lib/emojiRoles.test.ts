import { describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { canUseEmoji } from './emojiRoles';

describe('canUseEmoji', () => {
  it('lets everyone use an unrestricted emoji', () => {
    expect(canUseEmoji({}, [], 0n)).toBe(true);
    expect(canUseEmoji({ roleIds: [] }, undefined, 0n)).toBe(true);
  });
  it('requires a matching role or MANAGE_EMOJIS for a restricted one', () => {
    expect(canUseEmoji({ roleIds: ['a'] }, ['b'], 0n)).toBe(false);
    expect(canUseEmoji({ roleIds: ['a'] }, ['b', 'a'], 0n)).toBe(true);
    expect(canUseEmoji({ roleIds: ['a'] }, [], Perm.MANAGE_EMOJIS)).toBe(true);
  });
});
