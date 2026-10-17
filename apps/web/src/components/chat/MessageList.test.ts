import { describe, expect, it } from 'vitest';
import type { Message } from '@jorcord/shared';
import { buildRows } from './MessageList';

const author = (id: string) => ({ id, username: id, displayName: id, avatar: null }) as Message['author'];
const msg = (id: string, createdAt: string, authorId = 'u1', o: Partial<Message> = {}): Message => ({
  id, channelId: 'c1', guildId: 'g1', author: author(authorId), content: `m${id}`, createdAt, editedAt: null,
  type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false,
  attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...o,
});

const opts = { lastRead: null, hasMoreOlder: true, meId: 'me' };

describe('buildRows', () => {
  it('adds a date divider and groups consecutive messages from the same author', () => {
    const rows = buildRows([
      msg('2', '2026-01-01T10:00:00.000Z'),
      msg('3', '2026-01-01T10:01:00.000Z'),
      msg('4', '2026-01-01T10:02:00.000Z', 'u2'),
    ], [], opts);
    expect(rows.map((r) => r.kind)).toEqual(['date', 'msg', 'msg', 'msg']);
    expect(rows[1]).toMatchObject({ kind: 'msg', grouped: false });
    expect(rows[2]).toMatchObject({ kind: 'msg', grouped: true });
    expect(rows[3]).toMatchObject({ kind: 'msg', grouped: false });
  });

  it('inserts the unread divider before the first message past lastRead, but not my own', () => {
    const rows = buildRows([
      msg('2', '2026-01-01T10:00:00.000Z'),
      msg('3', '2026-01-01T10:01:00.000Z'),
      msg('4', '2026-01-01T10:02:00.000Z', 'me'),
    ], [], { ...opts, lastRead: '1' });
    expect(rows.map((r) => r.kind)).toEqual(['date', 'msg', 'new', 'msg', 'msg']);
  });

  it('appends pending messages at the end', () => {
    const rows = buildRows([msg('2', '2026-01-01T10:00:00.000Z')], [{ nonce: 'n1', createdAt: Date.now() }], opts);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'pending', nonce: 'n1' });
  });

  it('shows the channel intro only when there is nothing older to load', () => {
    const list = [msg('2', '2026-01-01T10:00:00.000Z')];
    expect(buildRows(list, [], { ...opts, hasMoreOlder: false })[0]).toMatchObject({ kind: 'intro' });
    expect(buildRows(list, [], { ...opts, hasMoreOlder: true })[0]).toMatchObject({ kind: 'date' });
  });
});
