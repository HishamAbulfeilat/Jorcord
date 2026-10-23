import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DigestEntry } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({
  api: {
    digest: { list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn(), remove: vi.fn() },
    users: { reminders: vi.fn(async () => []), mentions: vi.fn(async () => []), saved: vi.fn(async () => []) },
    messages: { scheduled: vi.fn(async () => []) },
  },
}));
vi.mock('@/lib/menus', () => ({ goto: vi.fn() }));
import { api } from '@/lib/api';
import { goto } from '@/lib/menus';
import { useData } from '@/stores/data';
import { InboxModal } from './SocialModals';

const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;
const entry = (o: Partial<DigestEntry> = {}): DigestEntry => ({
  id: 'e1', periodStart: '2026-10-22T08:00:00.000Z', periodEnd: '2026-10-23T08:00:00.000Z', total: 7, readAt: null, createdAt: '2026-10-23T08:00:00.000Z',
  items: [{ guildId: 'g1', channelId: 'c1', count: 5, mentions: 2, lastMessageId: '9' }, { guildId: null, channelId: 'dm1', count: 2, mentions: 2, lastMessageId: '8' }], ...o,
});

beforeEach(() => {
  vi.mocked(api.digest.list).mockReset(); vi.mocked(api.digest.markRead).mockReset().mockResolvedValue(undefined as never); vi.mocked(api.digest.markAllRead).mockReset().mockResolvedValue(undefined as never); vi.mocked(goto).mockReset();
  useData.setState({
    me: { id: 'me' } as never,
    guilds: { g1: { guild: { id: 'g1', name: 'Big Server' }, channels: { c1: { id: 'c1', name: 'announcements' } } } as never },
    dms: { dm1: { id: 'dm1', type: 'dm', recipients: [{ id: 'me', username: 'me' }, { id: 'u2', username: 'bob', displayName: 'Bob' }] } as never },
  });
});
afterEach(cleanup);

describe('Inbox > Digest', () => {
  it('lists held-back notifications per channel with counts, and badges the tab with the unread number', async () => {
    vi.mocked(api.digest.list).mockResolvedValue([entry(), entry({ id: 'e0', readAt: '2026-10-22T09:00:00.000Z' })]);
    render(wrap(<InboxModal initialTab="digest" close={vi.fn()} />));
    const list = await screen.findByRole('list', { name: 'Notification digests' });
    await waitFor(() => expect(list.textContent).toContain('7 notifications'));
    expect(list.textContent).toContain('#announcements'); expect(list.textContent).toContain('Big Server'); expect(list.textContent).toContain('5 new');
    expect(list.textContent).toContain('Bob'); expect(list.textContent).toContain('Direct Message');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Digest/ }).textContent).toContain('1'));
  });

  it('opens the channel from a digest line and marks that digest read; can mark all read', async () => {
    vi.mocked(api.digest.list).mockResolvedValue([entry()]);
    const close = vi.fn();
    render(wrap(<InboxModal initialTab="digest" close={close} />));
    fireEvent.click(await screen.findByText('#announcements'));
    await waitFor(() => expect(api.digest.markRead).toHaveBeenCalledWith('e1'));
    expect(goto).toHaveBeenCalledWith('g1', 'c1'); expect(close).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(api.digest.markAllRead).toHaveBeenCalled());
  });

  it('explains how to turn the feature on when there is nothing yet', async () => {
    vi.mocked(api.digest.list).mockResolvedValue([]);
    render(wrap(<InboxModal initialTab="digest" close={vi.fn()} />));
    expect(await screen.findByText('No digests yet')).toBeTruthy();
  });
});
