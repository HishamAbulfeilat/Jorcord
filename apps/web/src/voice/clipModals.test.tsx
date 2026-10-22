import { cleanup, render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ upload: vi.fn(), post: vi.fn(), list: vi.fn(), limits: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { files: { upload: m.upload }, clips: { post: m.post, list: m.list, remove: vi.fn(), limits: m.limits } } }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => ~0n }));
import { useClipUI } from '@/stores/clipui';
import { useData } from '@/stores/data';
import { setShareMaxSeconds, SHARE_MAX_SECONDS } from './clipBuffer';
import { ClipPreviewModal, ClipsViewerModal, clipFileName, shareTargets } from './ClipModals';

const clip = (durationSec: number) => ({ blob: new Blob(['x'.repeat(10)], { type: 'video/webm' }), durationSec, mimeType: 'video/webm', at: Date.UTC(2026, 0, 2, 3, 4, 5) });
const guilds = { g1: { guild: { id: 'g1', name: 'Guild' }, channels: { c1: { id: 'c1', guildId: 'g1', type: 'text', name: 'clips', isClipsChannel: true }, c2: { id: 'c2', guildId: 'g1', type: 'text', name: 'general' } }, members: {}, roles: {}, emojis: [] } };
beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  (URL as any).createObjectURL = vi.fn(() => 'blob:x'); (URL as any).revokeObjectURL = vi.fn();
  useData.setState({ me: { id: 'me' }, guilds } as never);
  m.limits.mockRejectedValue(new Error('offline')); setShareMaxSeconds(SHARE_MAX_SECONDS);
});
afterEach(cleanup);
const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;

describe('clip preview', () => {
  it('lists only clips channels I can post in, and names files by time', () => {
    expect(shareTargets()).toEqual([{ id: 'c1', label: 'Guild / #clips' }]);
    expect(clipFileName(Date.UTC(2026, 0, 2, 3, 4, 5), 'video/webm')).toBe('clip-2026-01-02T03-04-05-000Z.webm');
  });
  it('shares: uploads the file then posts it with the rounded duration', async () => {
    m.upload.mockResolvedValue({ id: 'att1' }); m.post.mockResolvedValue({});
    act(() => useClipUI.setState({ clip: clip(12.2) }));
    const close = vi.fn(); render(wrap(<ClipPreviewModal close={close} />));
    await act(async () => { screen.getByRole('button', { name: /Share to clips channel/ }).click(); });
    await vi.waitFor(() => expect(m.post).toHaveBeenCalledWith('c1', { attachmentId: 'att1', durationSeconds: 13, content: undefined }));
    expect((m.upload.mock.calls[0]![0] as File).type).toBe('video/webm'); expect(close).toHaveBeenCalled(); expect(useClipUI.getState().clip).toBeNull();
  });
  it('shares 1 and 2 minute clips (the API cap is 120 s)', () => {
    for (const d of [55, 119]) {
      act(() => useClipUI.setState({ clip: clip(d) }));
      const { unmount } = render(wrap(<ClipPreviewModal close={vi.fn()} />));
      expect((screen.getByRole('button', { name: /Share to clips channel/ }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId('clip-too-long')).toBeNull(); unmount();
    }
  });
  it('blocks sharing above the API limit but still allows download', () => {
    act(() => useClipUI.setState({ clip: clip(125) }));
    render(wrap(<ClipPreviewModal close={vi.fn()} />));
    expect((screen.getByRole('button', { name: /Share to clips channel/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('clip-too-long').textContent).toMatch(/at most 120 seconds/);
    expect(screen.getByRole('link', { name: /Download/ }).getAttribute('download')).toMatch(/\.webm$/);
  });
  it('uses the cap the server reports', async () => {
    m.limits.mockResolvedValue({ maxSeconds: 30, maxBytes: 1 });
    const mod = await import('./clipLimits'); // fresh module state is not needed: the first successful read wins
    act(() => useClipUI.setState({ clip: clip(55) }));
    render(wrap(<ClipPreviewModal close={vi.fn()} />));
    await act(async () => { await mod.loadClipLimits(); });
    await vi.waitFor(() => expect(screen.getByTestId('clip-too-long').textContent).toMatch(/at most 30 seconds/));
  });
  it('explains when there is no clips channel', () => {
    useData.setState({ guilds: { g1: { ...guilds.g1, channels: { c2: guilds.g1.channels.c2 } } } } as never);
    act(() => useClipUI.setState({ clip: clip(10) }));
    render(wrap(<ClipPreviewModal close={vi.fn()} />));
    expect(screen.getByTestId('clip-no-channel')).toBeTruthy();
  });
});

describe('clips viewer', () => {
  it('shows an empty state, then clips with their author', async () => {
    m.list.mockResolvedValueOnce([]);
    const { unmount } = render(wrap(<ClipsViewerModal channelId="c1" close={vi.fn()} />));
    expect(await screen.findByTestId('clips-empty')).toBeTruthy(); unmount();
    m.list.mockResolvedValueOnce([{ clipId: 'm1', author: { id: 'me', username: 'amy', displayName: 'Amy' }, content: 'wow', durationSeconds: 7, attachments: [{ id: 'a', url: '/files/a/x.webm' }] }]);
    render(wrap(<ClipsViewerModal channelId="c1" close={vi.fn()} />));
    expect(await screen.findByTestId('clip-card')).toBeTruthy(); expect(screen.getByText('Amy')).toBeTruthy(); expect(screen.getByText('7s')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete clip' })).toBeTruthy();
  });
});
