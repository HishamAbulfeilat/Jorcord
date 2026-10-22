import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '@jorcord/shared';
import { useData } from './data';

const ch = (id: string, o: Partial<Channel> = {}): Channel => ({ id, guildId: 'g1', type: 'text', name: id, topic: null, position: 0, parentId: null, nsfw: false, slowmode: 0, bitrate: null, userLimit: null, overwrites: [], lastMessageId: null, createdAt: '', ...o });
const thread = (id: string, parentId: string, o: Partial<Channel> = {}) => ch(id, { type: 'thread', parentId, ...o });

beforeEach(() => {
  useData.setState({
    guilds: { g1: { guild: { id: 'g1' } as never, channels: { a: ch('a'), b: ch('b'), t1: thread('t1', 'a'), t2: thread('t2', 'a', { private: true }), t3: thread('t3', 'b'), old: thread('old', 'a', { archived: true }) }, roles: {}, members: {}, emojis: [], stickers: [], memberCount: 1 } },
  } as never);
});
const ids = () => Object.keys(useData.getState().guilds.g1!.channels).sort();

describe('THREAD_LIST_SYNC', () => {
  it('replaces the active threads of the whole guild, keeping archived ones and non-threads', () => {
    useData.getState().apply('THREAD_LIST_SYNC', { guildId: 'g1', threads: [thread('t1', 'a'), thread('t4', 'b', { private: true })], members: [] });
    expect(ids()).toEqual(['a', 'b', 'old', 't1', 't4']);
  });
  it('limits the replacement to the given parent channels', () => {
    useData.getState().apply('THREAD_LIST_SYNC', { guildId: 'g1', channelIds: ['a'], threads: [thread('t1', 'a')], members: [] });
    expect(ids()).toEqual(['a', 'b', 'old', 't1', 't3']); // t2 (under a) dropped, t3 (under b) untouched
  });
});
