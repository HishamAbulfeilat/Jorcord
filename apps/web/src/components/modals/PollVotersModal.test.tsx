import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { messages: { voters: vi.fn() } } }));
import { api } from '@/lib/api';
import { PollVotersModal } from './PlatformModals';
import { useMessages } from '@/stores/messages';

const voters = vi.mocked(api.messages.voters);

const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;
const user = (i: number) => ({ id: `u${String(i).padStart(2, '0')}`, username: `u${i}`, displayName: `Voter ${i}`, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const range = (n: number) => [...Array(n).keys()];
const msg: Message = {
  id: 'm1', channelId: 'ch', guildId: null, author: user(0) as never, content: '', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null,
  mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null,
  poll: { question: 'Lunch?', answers: [{ id: 1, text: 'Pizza', count: 27, meVoted: false, emoji: null }, { id: 2, text: 'Sushi', count: 0, meVoted: false, emoji: null }], allowMultiselect: true, layoutType: 1 as const, expiry: new Date(Date.now() + 3600_000).toISOString(), isFinalized: false, totalVotes: 27 },
};

const PAGE = 25; // the modal's page size: rule from the visible list

beforeEach(() => {
  // full first page ("Load more" appears), then the few remaining voters, then the stream ends
  voters.mockReset().mockImplementation((_c: string, _i: string, answerId: number, after: string | undefined) => Promise.resolve(answerId === 2 ? [] :
    after ? [25, 26].map(user) : range(PAGE).map(user) as never));
  useMessages.getState().init('ch', [msg], 50);
});
afterEach(cleanup);

describe('PollVotersModal', () => {
  it('lists an answer\'s voters and pages in the rest on "Load more"', async () => {
    render(wrap(<PollVotersModal channelId="ch" messageId="m1" close={vi.fn()} />));
    expect(await screen.findByText('Voter 0')).toBeTruthy();
    expect((screen.getByTestId('voters') as HTMLElement).children).toHaveLength(PAGE);
    expect(voters).toHaveBeenCalledWith('ch', 'm1', 1, undefined, PAGE);
    fireEvent.click(screen.getByTestId('voters-more'));
    await waitFor(() => expect((screen.getByTestId('voters') as HTMLElement).children).toHaveLength(PAGE + 2));
    expect(voters).toHaveBeenLastCalledWith('ch', 'm1', 1, 'u24', PAGE); // cursor = last voter of the previous page
    expect(screen.queryByTestId('voters-more')).toBeNull(); // exhausted: the button disappears
  });
  it('switching to another answer restarts from its first page', async () => {
    render(wrap(<PollVotersModal channelId="ch" messageId="m1" close={vi.fn()} />));
    await screen.findByText('Voter 0');
    fireEvent.click(screen.getByRole('tab', { name: /Sushi/ }));
    await screen.findByText('No votes yet.');
    expect(voters).toHaveBeenLastCalledWith('ch', 'm1', 2, undefined, PAGE);
  });
});
