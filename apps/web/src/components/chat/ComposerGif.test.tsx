import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Channel } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';

vi.mock('@/lib/api', () => ({ api: { messages: { send: vi.fn().mockResolvedValue({ id: 'm1', channelId: 'dm1', content: '', author: { id: 'me' }, attachments: [], embeds: [], reactions: [], mentions: [] }) }, channels: { typing: vi.fn(), ack: vi.fn().mockResolvedValue(undefined) } } }));
vi.mock('@/lib/gateway', () => ({ getGateway: () => ({ status: 'disconnected', sendTyping: vi.fn() }) }));
vi.mock('@/lib/useGuild', () => ({ useGuildPerms: () => 0n }));
vi.mock('@/lib/hooks', () => ({ useIsMobile: () => false }));
import { api } from '@/lib/api';
import { Composer } from './Composer';

const chan = { id: 'dm1', type: 'dm', name: null, recipients: [{ id: 'u2', username: 'jess', displayName: 'Jess' }] } as unknown as Channel;
afterEach(cleanup);

describe('Composer GIF button', () => {
  it('opens the GIF picker (GIF-only) and sends the chosen GIF URL as the message', async () => {
    useData.setState({ me: { id: 'me' }, users: {}, guilds: {}, dms: { dm1: chan }, channels: {} } as never);
    render(<QueryClientProvider client={new QueryClient()}><Composer channel={chan} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open GIF picker' }));
    const p = useUI.getState().popout as any;
    expect(p.kind).toBe('emoji'); expect(p.gifOnly).toBe(true);
    p.onPick({ name: 'cat', gif: 'https://media.giphy.com/media/x/giphy.gif' });
    await vi.waitFor(() => expect(api.messages.send).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(api.messages.send).mock.calls[0])).toContain('https://media.giphy.com/media/x/giphy.gif');
  });
});
