import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@jorcord/shared';
import { useMessages } from './messages';

const user = (id: string) => ({ id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const msg = (id: string): Message => ({ id, channelId: 'ch', guildId: null, author: user('u1'), content: 'hi', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null });
const reactions = () => useMessages.getState().ch.ch!.list[0]!.reactions;

beforeEach(() => useMessages.setState({ ch: {}, pending: [] }));

describe('burst (super) reactions in the message store', () => {
  it('keeps the burst count separate from the regular count for the same emoji', () => {
    useMessages.getState().init('ch', [msg('1')], 50);
    useMessages.getState().reaction('ch', '1', '🔥', null, 1, true, false);
    useMessages.getState().reaction('ch', '1', '🔥', null, 1, true, true, '#EB459E');
    expect(reactions()).toEqual([
      { emoji: '🔥', emojiId: null, count: 1, me: true, burstCount: 1, meBurst: true, burstColors: ['#EB459E'] },
    ]);
  });

  it('a burst-only reaction starts at zero regular count and carries my flag', () => {
    useMessages.getState().init('ch', [msg('1')], 50);
    useMessages.getState().reaction('ch', '1', '🎉', null, 1, false, true, '#57F287');
    expect(reactions()[0]).toEqual({ emoji: '🎉', emojiId: null, count: 0, me: false, burstCount: 1, meBurst: false, burstColors: ['#57F287'] });
  });

  it('removing one variant leaves the other in place', () => {
    useMessages.getState().init('ch', [msg('1')], 50);
    const r = useMessages.getState().reaction;
    r('ch', '1', '🔥', null, 1, true, false); r('ch', '1', '🔥', null, 1, true, true);
    r('ch', '1', '🔥', null, -1, true, false);
    expect(reactions()[0]).toMatchObject({ count: 0, me: false, burstCount: 1, meBurst: true });
    r('ch', '1', '🔥', null, -1, true, true);
    expect(reactions()).toEqual([]);
  });
});
