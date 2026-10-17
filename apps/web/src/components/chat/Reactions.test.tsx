import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { messages: { react: vi.fn().mockResolvedValue(undefined), unreact: vi.fn().mockResolvedValue(undefined), reactors: vi.fn() } } }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => ~0n }));
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { ReactionBar, addReaction } from './Reactions';

const u = (id: string) => ({ id, username: id, displayName: id.toUpperCase(), avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const base = (reactions: Message['reactions']): Message => ({ id: '1', channelId: 'ch', guildId: null, author: u('x'), content: 'hi', createdAt: '', editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions, pinned: false, stickerIds: [], threadId: null } as Message);
const cur = () => useMessages.getState().ch.ch!.list[0]!;
const Bar = () => { const m = useMessages((s) => s.ch.ch?.list[0]); return m ? <ReactionBar m={m} /> : null; };
const wrap = () => render(<QueryClientProvider client={new QueryClient()}><Bar /></QueryClientProvider>);

beforeEach(() => { vi.clearAllMocks(); useData.setState({ me: u('me'), guilds: {} } as never); useMessages.setState({ ch: {}, pending: [] }); });
afterEach(cleanup);

describe('reactions', () => {
  it('clicking an existing reaction toggles mine on and off', () => {
    useMessages.getState().init('ch', [base([{ emoji: '👍', emojiId: null, count: 2, me: false }])], 50);
    wrap();
    fireEvent.click(screen.getByRole('button', { name: '👍 2' }));
    expect(api.messages.react).toHaveBeenCalledWith('ch', '1', '👍', null, false);
    expect(cur().reactions[0]).toMatchObject({ count: 3, me: true });
    fireEvent.click(screen.getByRole('button', { name: '👍 3' }));
    expect(api.messages.unreact).toHaveBeenCalled();
    expect(cur().reactions[0]).toMatchObject({ count: 2, me: false });
  });

  it('the gateway echo of my own reaction is not counted twice (live updates stay exact)', () => {
    useMessages.getState().init('ch', [base([])], 50);
    addReaction(cur(), { char: '🎉', name: 'tada' });
    expect(cur().reactions[0]).toMatchObject({ count: 1, me: true });
    useMessages.getState().reaction('ch', '1', '🎉', null, 1, true); // MESSAGE_REACTION_ADD echo for me
    expect(cur().reactions[0]).toMatchObject({ count: 1, me: true });
    useMessages.getState().reaction('ch', '1', '🎉', null, 1, false); // someone else
    expect(cur().reactions[0]).toMatchObject({ count: 2, me: true });
    useMessages.getState().reaction('ch', '1', '🎉', null, -1, true);
    useMessages.getState().reaction('ch', '1', '🎉', null, -1, true); // remove + its echo
    expect(cur().reactions[0]).toMatchObject({ count: 1, me: false });
  });

  it('super reactions toggle separately and custom emoji react with their id', () => {
    useMessages.getState().init('ch', [base([{ emoji: 'pog', emojiId: 'e1', count: 1, me: false, burstCount: 1, meBurst: false, burstColors: ['#fff'] }])], 50);
    wrap();
    fireEvent.click(screen.getByRole('button', { name: /pog 1 super reaction/ }));
    expect(api.messages.react).toHaveBeenCalledWith('ch', '1', 'pog', 'e1', true);
    expect(cur().reactions[0]).toMatchObject({ burstCount: 2, meBurst: true, count: 1, me: false });
    fireEvent.click(screen.getByRole('button', { name: 'pog 1' }));
    expect(api.messages.react).toHaveBeenLastCalledWith('ch', '1', 'pog', 'e1', false);
  });

  it('hovering a reaction shows who reacted', async () => {
    vi.mocked(api.messages.reactors).mockResolvedValue([u('ann'), u('bob')] as never);
    useMessages.getState().init('ch', [base([{ emoji: '👍', emojiId: null, count: 3, me: false }])], 50);
    wrap();
    const pill = screen.getByRole('button', { name: '👍 3' }).parentElement!;
    fireEvent.mouseEnter(pill);
    await waitFor(() => expect(screen.getByTestId('reactors-hover').textContent).toBe('ANN, BOB and 1 other reacted with 👍'));
    expect(api.messages.reactors).toHaveBeenCalledWith('ch', '1', '👍', null, false);
    fireEvent.mouseLeave(pill);
    expect(screen.queryByTestId('reactors-hover')).toBeNull();
  });
});
