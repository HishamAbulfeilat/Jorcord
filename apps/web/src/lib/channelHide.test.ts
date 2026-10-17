import { describe, expect, it } from 'vitest';
import { channelShown, optInChannels, type HideRules } from './channelHide';

const base: HideRules = { currentId: 'cur', hideMuted: false, muted: {}, optIn: new Set(), chosen: null, browseAll: false };
describe('sidebar channel filters', () => {
  it('shows everything by default', () => { expect(channelShown({ id: 'a' }, base)).toBe(true); });
  it('hides muted channels only when asked, but never the open one', () => {
    const r = { ...base, hideMuted: true, muted: { a: true, cur: true } };
    expect(channelShown({ id: 'a' }, r)).toBe(false); expect(channelShown({ id: 'cur' }, r)).toBe(true); expect(channelShown({ id: 'b' }, r)).toBe(true);
    expect(channelShown({ id: 'a' }, { ...r, hideMuted: false })).toBe(true);
  });
  it('hides opt-in channels I did not choose; browse-all and unanswered show them', () => {
    const r = { ...base, optIn: new Set(['x', 'y']), chosen: new Set(['x']) };
    expect(channelShown({ id: 'x' }, r)).toBe(true); expect(channelShown({ id: 'y' }, r)).toBe(false); expect(channelShown({ id: 'z' }, r)).toBe(true);
    expect(channelShown({ id: 'y' }, { ...r, browseAll: true })).toBe(true); expect(channelShown({ id: 'y' }, { ...r, chosen: null })).toBe(true);
  });
  it('opt-in channels are option channels that are not defaults', () => {
    const o = { defaultChannelIds: ['g'], prompts: [{ id: 'p', title: 'q', singleSelect: false, required: false, options: [{ id: 'o1', title: 'a', description: null, emoji: null, channelIds: ['g', 'x'], roleIds: [] }] }] };
    expect([...optInChannels(o)]).toEqual(['x']); expect(optInChannels(undefined).size).toBe(0);
  });
});
