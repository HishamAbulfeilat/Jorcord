import { describe, expect, it } from 'vitest';
import { MessageFlags, Perm, type Message } from '@jorcord/shared';
import { historyItem, sensitiveToggle } from './menus';

const msg = (o: Partial<Message> = {}): Message => ({ id: 'm', channelId: 'c', guildId: 'g', author: { id: 'bob' } as never, content: 'x', createdAt: '', editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...o } as Message);
const label = (i: ReturnType<typeof sensitiveToggle>) => (i && 'label' in i ? i.label : null);

describe('sensitiveToggle', () => {
  it('moderators can mark and unmark anyone\'s message; authors only mark their own', () => {
    expect(label(sensitiveToggle(msg(), 'mod', Perm.MANAGE_MESSAGES))).toBe('Mark sensitive');
    expect(label(sensitiveToggle(msg({ flags: MessageFlags.SENSITIVE }), 'mod', Perm.MANAGE_MESSAGES))).toBe('Remove sensitive mark');
    expect(label(sensitiveToggle(msg(), 'bob', 0n))).toBe('Mark sensitive');
    expect(sensitiveToggle(msg({ flags: MessageFlags.SENSITIVE }), 'bob', 0n)).toBeNull(); // an author cannot lift a moderator's mark
    expect(sensitiveToggle(msg(), 'eve', 0n)).toBeNull();
  });
  it('is for server messages only', () => {
    expect(sensitiveToggle(msg({ guildId: null }), 'bob', Perm.MANAGE_MESSAGES)).toBeNull();
  });
});

describe('historyItem', () => {
  it('only for edited messages, to the author and moderators', () => {
    const edited = msg({ editedAt: new Date().toISOString() });
    expect(historyItem(msg(), 'bob', Perm.MANAGE_MESSAGES)).toBeNull();
    expect(historyItem(edited, 'bob', 0n)).not.toBeNull();
    expect(historyItem(edited, 'mod', Perm.MANAGE_MESSAGES)).not.toBeNull();
    expect(historyItem(edited, 'eve', 0n)).toBeNull();
  });
});
