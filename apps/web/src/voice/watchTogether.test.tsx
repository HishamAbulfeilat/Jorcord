import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelActivity } from '@jorcord/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), update: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { activities: mocks } }));

import { useData } from '@/stores/data';
import { useChannelActivities } from '@/stores/channelActivities';
import { parseYouTubeId, watchState, WatchTogetherPopover, youTubeEmbedUrl, WATCH_IFRAME_SANDBOX } from './WatchTogether';

const activity = (state: unknown, over: Partial<ChannelActivity> = {}): ChannelActivity => ({
  id: 'a1', channelId: 'v1', guildId: 'g1', kind: 'youtube', hostId: 'me', state,
  startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

beforeEach(() => {
  useData.setState({ me: { id: 'me' } } as never);
  useChannelActivities.setState({ byChannel: {} } as never);
  mocks.list.mockReset().mockResolvedValue({ activities: [] });
  mocks.start.mockReset().mockImplementation(async (_channelId: string, b: any) => activity(b.state));
  mocks.update.mockReset().mockImplementation(async (_id: string, state: unknown) => activity(state, { updatedAt: '2026-01-01T00:00:10.000Z' }));
  mocks.end.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

const wrap = (el: React.ReactElement) => render(el);

describe('YouTube link parsing', () => {
  it('accepts only youtube.com / youtu.be links with an 11-character video id', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=share')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');

    expect(parseYouTubeId('https://vimeo.com/123456')).toBeNull();
    expect(parseYouTubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeId('https://youtube.com/watch?v=tooShort')).toBeNull();
    expect(parseYouTubeId('https://youtu.be/abcdefghijkl')).toBeNull();
    expect(parseYouTubeId('')).toBeNull();
  });

  it('embeds only youtube-nocookie.com with the required sandbox and validates server state', () => {
    const url = new URL(youTubeEmbedUrl('dQw4w9WgXcQ'));
    expect(url.origin).toBe('https://www.youtube-nocookie.com');
    expect(url.pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(WATCH_IFRAME_SANDBOX).toBe('allow-scripts allow-same-origin allow-presentation');
    expect(watchState(activity({ videoId: 'dQw4w9WgXcQ', position: 7, playing: true }))).toEqual({ videoId: 'dQw4w9WgXcQ', position: 7, playing: true });
    expect(watchState(activity({ videoId: 'https://evil.test/x', position: 7, playing: true }))).toBeNull();
  });
});

describe('Watch Together panel', () => {
  it('starts a session from a pasted link and mounts only the sandboxed no-cookie player', async () => {
    wrap(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('v1'));

    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Watch Together' }));

    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith('v1', {
      kind: 'youtube', state: { videoId: 'dQw4w9WgXcQ', position: 0, playing: true },
    }));
    const frame = (await screen.findByTitle('YouTube video')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe(WATCH_IFRAME_SANDBOX);
    expect(new URL(frame.src).origin).toBe('https://www.youtube-nocookie.com');
  });

  it('refuses links from other domains and never calls the API', async () => {
    wrap(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: 'https://vimeo.com/123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Watch Together' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('youtube.com'));
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('publishes play/pause and seek changes so every viewer gets them as ACTIVITY_UPDATE', async () => {
    useChannelActivities.setState({ byChannel: { v1: [activity({ videoId: 'dQw4w9WgXcQ', position: 5, playing: true })] } } as never);
    wrap(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a1', { videoId: 'dQw4w9WgXcQ', position: 5, playing: false }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Seek to (seconds)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seek' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a1', { videoId: 'dQw4w9WgXcQ', position: 30, playing: false }));
  });

  it('does not offer playback controls to a viewer who is not the host', () => {
    useChannelActivities.setState({ byChannel: { v1: [activity({ videoId: 'dQw4w9WgXcQ', position: 5, playing: true }, { hostId: 'someone-else' })] } } as never);
    wrap(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.getByText('The host controls playback.')).toBeTruthy();
  });
});
