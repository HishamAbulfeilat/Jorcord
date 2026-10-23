import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StreamFeed, StreamFeedsResponse } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { streamFeeds: vi.fn(), createStreamFeed: vi.fn(), patchStreamFeed: vi.fn(), deleteStreamFeed: vi.fn() } } }));
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { StreamFeedsPanel } from './StreamFeedsPanel';

const list = vi.mocked(api.guilds.streamFeeds), create = vi.mocked(api.guilds.createStreamFeed), patch = vi.mocked(api.guilds.patchStreamFeed), del = vi.mocked(api.guilds.deleteStreamFeed);
const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;
const ch = (id: string, name: string, position: number, type = 'text') => ({ id, guildId: 'g1', type, name, topic: null, position, parentId: null, nsfw: false, slowmode: 0, overwrites: [], lastMessageId: null });
const role = (id: string, name: string, position: number) => ({ id, guildId: 'g1', name, color: 0, hoist: false, position, permissions: '0', mentionable: true, icon: null });
const feed = (o: Partial<StreamFeed> = {}): StreamFeed => ({ id: 'f1', guildId: 'g1', provider: 'youtube', externalId: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Cool Channel', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa', channelId: 'c1', template: 'x', roleId: null, enabled: true, lastAnnouncedAt: null, lastError: null, createdBy: 'u1', createdAt: new Date().toISOString(), ...o });
const resp = (feeds: StreamFeed[], twitch = false): StreamFeedsResponse => ({ feeds, providers: { twitch, youtube: true }, max: 25 });

beforeEach(() => {
  list.mockReset(); create.mockReset(); patch.mockReset(); del.mockReset();
  useData.setState({ guilds: { g1: { guild: { id: 'g1', name: 'Hub', features: [] }, channels: { c1: ch('c1', 'general', 0), c2: ch('c2', 'live', 1, 'announcement'), c3: ch('c3', 'voice', 2, 'voice') }, roles: { g1: role('g1', '@everyone', 0), r1: role('r1', 'Subs', 1) }, members: {}, emojis: [], stickers: [], memberCount: 1 } } } as never);
});
afterEach(cleanup);

describe('Server Settings > Integrations > stream feeds', () => {
  it('lists feeds with their target channel and shows the last provider error', async () => {
    list.mockResolvedValue(resp([feed(), feed({ id: 'f2', name: 'Streamer', provider: 'twitch', channelId: 'c2', lastError: 'Twitch rate limit, retrying later' })]));
    render(wrap(<StreamFeedsPanel guildId="g1" />));
    const rows = await screen.findAllByTestId('stream-feed');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Cool Channel')).toBeTruthy(); expect(within(rows[0]!).getByText('posts in #general')).toBeTruthy();
    expect(within(rows[0]!).queryByTestId('feed-error')).toBeNull();
    expect(within(rows[1]!).getByTestId('feed-error').textContent).toContain('Twitch rate limit');
    expect(screen.getByText('2 of 25 feeds used')).toBeTruthy();
    expect(list).toHaveBeenCalledWith('g1');
  });

  it('only offers text channels and non-default roles; Twitch is disabled when the server has no credentials', async () => {
    list.mockResolvedValue(resp([]));
    render(wrap(<StreamFeedsPanel guildId="g1" />));
    expect(await screen.findByText('No feeds yet')).toBeTruthy();
    const post = screen.getByLabelText('Post in') as HTMLSelectElement;
    expect([...post.options].map((o) => o.textContent)).toEqual(['#general', '#live']);
    expect([...(screen.getByLabelText('Mention role') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['No mention', '@Subs']);
    const svc = screen.getByLabelText('Service') as HTMLSelectElement;
    expect([...svc.options].find((o) => o.value === 'twitch')!.disabled).toBe(true);
  });

  it('adds a feed with the chosen channel, role and template; the button waits for a channel to watch', async () => {
    list.mockResolvedValue(resp([], true)); create.mockResolvedValue(feed());
    render(wrap(<StreamFeedsPanel guildId="g1" />));
    await screen.findByText('No feeds yet');
    const add = screen.getByRole('button', { name: 'Add feed' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'twitch' } });
    fireEvent.change(screen.getByLabelText('Twitch channel'), { target: { value: ' ninja ' } });
    fireEvent.change(screen.getByLabelText('Post in'), { target: { value: 'c2' } });
    fireEvent.change(screen.getByLabelText('Mention role'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '{channel} is live {url}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('g1', { provider: 'twitch', channel: 'ninja', channelId: 'c2', roleId: 'r1', template: '{channel} is live {url}' }));
    await waitFor(() => expect((screen.getByLabelText('Twitch channel') as HTMLInputElement).value).toBe('')); // form reset
  });

  it('pauses, edits and removes a feed', async () => {
    list.mockResolvedValue(resp([feed({ roleId: 'r1' })])); patch.mockResolvedValue(feed()); del.mockResolvedValue(undefined as never);
    render(wrap(<StreamFeedsPanel guildId="g1" />));
    const row = await screen.findByTestId('stream-feed');
    fireEvent.click(within(row).getByRole('switch', { name: 'Enabled: Cool Channel' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('g1', 'f1', { enabled: false }));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit Cool Channel' }));
    const editor = within(row).getByRole('form', { name: 'Edit feed' });
    fireEvent.change(within(editor).getByLabelText('Mention role'), { target: { value: '' } });
    fireEvent.change(within(editor).getByLabelText('Message'), { target: { value: 'New: {title}' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('g1', 'f1', { channelId: 'c1', roleId: null, template: 'New: {title}' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Cool Channel' }));
    const modal = useUI.getState().modal as any; expect(modal.kind).toBe('confirm'); expect(modal.danger).toBe(true);
    await modal.onConfirm();
    expect(del).toHaveBeenCalledWith('g1', 'f1');
  });

  it('stops adding at the cap', async () => {
    list.mockResolvedValue({ ...resp(Array.from({ length: 25 }, (_, i) => feed({ id: `f${i}`, name: `C${i}` }))) });
    render(wrap(<StreamFeedsPanel guildId="g1" />));
    await screen.findAllByTestId('stream-feed');
    fireEvent.change(screen.getByLabelText('YouTube channel'), { target: { value: '@someone' } });
    expect((screen.getByRole('button', { name: 'Add feed' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
