import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';

vi.mock('@/lib/api', () => ({ api: { guilds: { search: vi.fn() } } }));
vi.mock('@/lib/nav', () => ({ useNav: () => ({ base: '', path: () => '', go: (...args: unknown[]) => { navCalls.push(args); }, home: () => {}, to: () => {} }) }));
import { api } from '@/lib/api';
import { SearchPanel } from './Panels';

const navCalls: unknown[][] = [];
const search = vi.mocked(api.guilds.search);
const user = (id: string, o: Record<string, unknown> = {}) => ({ id, username: id, displayName: id, avatar: null, avatarDecoration: null, banner: null, bio: null, accentColor: null, pronouns: null, bot: false, createdAt: '', ...o });
const msg = (o: Partial<Message> = {}): Message => ({ id: 'm1', channelId: 'ch1', guildId: null, author: user('alice'), content: '', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...o });
const chan = { id: 'ch1', name: 'general', type: 'text', guildId: 'g1', position: 0, parentId: null } as never;
const maybeWrap = (children: React.ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;

afterEach(cleanup);

beforeEach(() => {
  useUI.setState({ searchQuery: '' });
  useData.setState({ users: {}, guilds: {}, dms: {} } as never);
  search.mockReset();
  navCalls.length = 0;
});

describe('SearchPanel', () => {
  it('shows the search box and the start hint, and fires nothing until there is a query', () => {
    render(maybeWrap(<SearchPanel guildId={undefined} channel={chan} onClose={vi.fn()} />));
    expect(screen.getByRole('complementary', { name: 'Search Results' })).toBeTruthy();
    expect((screen.getByLabelText('Search messages') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Type at least two characters.')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it('typing in the box updates the shared search query; the fetch waits for the debounce', () => {
    render(maybeWrap(<SearchPanel guildId={undefined} channel={chan} onClose={vi.fn()} />));
    fireEvent.change(screen.getByLabelText('Search messages'), { target: { value: 'pizza time' } });
    expect(useUI.getState().searchQuery).toBe('pizza time');
    expect(search).not.toHaveBeenCalled();
  });

  it('toggles a has: chip and searches for it even without free text', async () => {
    search.mockResolvedValue([]);
    render(maybeWrap(<SearchPanel guildId={undefined} channel={chan} onClose={vi.fn()} />));
    const chip = screen.getByRole('button', { name: 'has: image' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await screen.findByText('No results found');
    expect(search).toHaveBeenCalledWith('@me', expect.objectContaining({ has: 'image' }));
    fireEvent.click(chip); // filter off -> no remaining query filters -> disabled again
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('runs a guild-scope search, shows hits with their channel and opens them', async () => {
    useUI.setState({ searchQuery: 'pizza' });
    useData.setState({ guilds: { g1: { channels: { ch1: chan }, members: {} } } } as never);
    search.mockResolvedValue([msg({ content: 'Pizza for lunch', guildId: 'g1', author: user('alice') })]);
    render(maybeWrap(<SearchPanel guildId="g1" channel={chan} onClose={vi.fn()} />));
    await screen.findByText('Pizza for lunch');
    expect(screen.getByText('general')).toBeTruthy();
    expect(search).toHaveBeenCalledWith('g1', expect.objectContaining({ q: 'pizza', channelId: undefined }));
    fireEvent.click(screen.getByText('Pizza for lunch').closest('button')!);
    expect(navCalls).toEqual([['g1', 'ch1']]);
  });

  it('warns instead of searching when a from: name matches no member', () => {
    useUI.setState({ searchQuery: 'from:ghost' });
    useData.setState({ guilds: { g1: { channels: { ch1: chan }, members: { u1: { user: user('alice'), nick: null } } } } } as never);
    render(maybeWrap(<SearchPanel guildId="g1" channel={chan} onClose={vi.fn()} />));
    expect(screen.getByText('No member matches "ghost".')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });
});
