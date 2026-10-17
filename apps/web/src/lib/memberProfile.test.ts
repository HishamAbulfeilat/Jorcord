import { describe, expect, it } from 'vitest';
import { memberProfile } from './memberProfile';

const user = { avatar: '/u.png', banner: '/ub.png', bio: 'user bio', pronouns: 'they' };

describe('memberProfile', () => {
  it('falls back to the user-level fields when the member has no override', () => {
    expect(memberProfile(user, { avatar: null, banner: null, bio: null, pronouns: null })).toEqual(user);
    expect(memberProfile(user)).toEqual(user);
  });

  it('prefers per-server overrides', () => {
    expect(memberProfile(user, { avatar: '/m.png', banner: '/mb.png', bio: 'server bio', pronouns: 'she' }))
      .toEqual({ avatar: '/m.png', banner: '/mb.png', bio: 'server bio', pronouns: 'she' });
  });

  it('treats an empty-string override as unset', () => {
    expect(memberProfile(user, { avatar: '', banner: '', bio: '', pronouns: '' })).toEqual(user);
  });

  it('returns nulls when neither side is set', () => {
    const none = { avatar: null, banner: null, bio: null, pronouns: null };
    expect(memberProfile(null, null)).toEqual(none);
    expect(memberProfile(none)).toEqual(none);
  });
});
