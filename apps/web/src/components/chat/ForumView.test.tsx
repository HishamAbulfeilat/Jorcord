import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@jorcord/shared';

const nav = vi.hoisted(() => ({ go: vi.fn() }));
vi.mock('@/lib/nav', () => ({ useNav: () => ({ base: '', path: () => '', go: nav.go, home: vi.fn(), to: vi.fn() }) }));
vi.mock('@/lib/useGuild', () => ({ useGuildPerms: () => 0n }));
vi.mock('./ChatView', () => ({ ChannelHeader: () => null }));

import { useData } from '@/stores/data';
import { ForumView } from './ForumView';

const user = { id: '1', username: 'ann', displayName: 'Ann', avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '', customStatus: null, themeColors: null, avatarDecoration: null, profileEffect: null, namePlate: null, serverTag: null, presence: 'online' };
const post = (o: Partial<Channel> = {}): Channel => ({ id: '1000000000000000001', type: 'thread', name: 'Post', guildId: '1', parentId: '4000000000000000001', ownerId: '1', createdAt: new Date().toISOString(), ...o } as unknown as Channel);
const channel = (type: 'forum' | 'media', o: Partial<Channel> = {}): Channel => ({ id: '4000000000000000001', type, name: type === 'media' ? 'clips' : 'ideas', guildId: '1', availableTags: [], ...o } as unknown as Channel);

const setData = (channels: Record<string, Channel>) => useData.setState({ users: { '1': user }, guilds: { '1': { channels } } } as never);

beforeEach(() => { nav.go.mockClear(); useData.setState({ users: {}, guilds: {} } as never); });
afterEach(cleanup);

describe('ForumView', () => {
  it('titles a media channel as a gallery and asks for the first image or video', () => {
    setData({ '4000000000000000001': channel('media') });
    render(<ForumView channel={channel('media')} />);
    expect(screen.getByRole('heading', { name: 'Media' })).toBeTruthy();
    expect(screen.getByText('No media yet')).toBeTruthy();
    expect(screen.getByText('Be the first to share an image or video.')).toBeTruthy();
  });

  it('keeps forum wording for a regular forum channel', () => {
    setData({ '4000000000000000001': channel('forum') });
    render(<ForumView channel={channel('forum')} />);
    expect(screen.getByRole('heading', { name: 'Posts' })).toBeTruthy();
    expect(screen.getByText('No posts yet')).toBeTruthy();
  });

  it('renders each post as a card and opens the thread when clicked', () => {
    const a = post({ id: '1000000000000000002', name: 'Sunrise', lastMessageId: '2000000000000000002' });
    const b = post({ id: '1000000000000000001', name: 'Beach', lastMessageId: '2000000000000000001' });
    setData({ '4000000000000000001': channel('media'), [a.id]: a, [b.id]: b });
    render(<ForumView channel={channel('media')} />);
    // most-recently-active posts sort first
    const titles = screen.getAllByRole('button', { name: /Sunrise|Beach/ }).map((el) => el.textContent);
    expect(titles[0]).toContain('Sunrise');
    expect(screen.queryByText('No media yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Beach/ }));
    expect(nav.go).toHaveBeenCalledWith('1', b.id);
  });
});
