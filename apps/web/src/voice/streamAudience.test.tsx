import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm } from '@jorcord/shared';

const m = vi.hoisted(() => ({
  watch: vi.fn(), streams: vi.fn(), limit: vi.fn(), kick: vi.fn(), perms: 0n as bigint,
}));
vi.mock('@/lib/api', () => ({ api: { voice: { streamWatch: m.watch, streams: m.streams, streamLimit: m.limit, streamKick: m.kick } } }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => m.perms }));

import { useData } from '@/stores/data';
import { useLiveVoice } from '@/stores/livevoice';
import { useVoiceUI } from '@/stores/voiceui';
import { StreamAudience, useStreamGate } from './StreamAudience';
import { syncStreamAudience, syncPrioritySpeakers } from './controller';

const vs = (userId: string, over: Record<string, unknown> = {}) => ({ userId, guildId: 'g1', channelId: 'v1', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false, ...over });
const user = (id: string, name: string) => ({ id, username: name, displayName: name, avatar: null });

beforeEach(() => {
  Object.values(m).forEach((f) => typeof f === 'function' && (f as ReturnType<typeof vi.fn>).mockReset());
  m.perms = 0n; m.watch.mockResolvedValue({}); m.streams.mockResolvedValue([]); m.limit.mockResolvedValue({}); m.kick.mockResolvedValue(undefined);
  useLiveVoice.getState().reset();
  useVoiceUI.setState({ connectedChannelId: 'v1' } as never);
  useData.setState({
    me: { id: 'me' }, users: { me: user('me', 'Me'), s: user('s', 'Streamer'), a: user('a', 'Ann'), b: user('b', 'Bob') },
    voiceStates: { me: vs('me'), s: vs('s', { streaming: true }), a: vs('a', { watching: 's' }), b: vs('b', { watching: 's' }) },
  } as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('who is watching', () => {
  it('shows the count and the viewers of a stream to everyone in the channel, without remove buttons for plain members', async () => {
    useData.setState({ voiceStates: { ...useData.getState().voiceStates, s: vs('s', { streaming: true, streamViewerLimit: 5 }) } } as never);
    render(<StreamAudience streamerId="s" />);
    expect(screen.getByTestId('stream-viewer-count').textContent).toBe('2 / 5');
    fireEvent.click(screen.getByTestId('stream-viewers-button'));
    const panel = await screen.findByTestId('stream-viewers-panel');
    expect(panel.textContent).toContain('Ann'); expect(panel.textContent).toContain('Bob');
    expect(screen.queryByRole('button', { name: /Remove Ann/ })).toBeNull();
    expect(screen.queryByLabelText('Viewer limit')).toBeNull(); // only the streamer sets the limit
    await waitFor(() => expect(m.streams).toHaveBeenCalledWith('v1'));
  });

  it('lets the streamer remove a viewer, allow them again, and change the viewer limit', async () => {
    useData.setState({ me: { id: 's' } } as never);
    m.streams.mockResolvedValue([{ channelId: 'v1', streamerId: 's', viewerLimit: null, effectiveLimit: 99, viewerCount: 2, viewers: ['a', 'b'], kicked: ['b2'] }]);
    useData.setState({ users: { ...useData.getState().users, b2: user('b2', 'Removed Rick') } } as never);
    render(<StreamAudience streamerId="s" />);
    fireEvent.click(screen.getByTestId('stream-viewers-button'));
    await screen.findByText('Removed Rick');
    fireEvent.click(screen.getByRole('button', { name: /Remove Ann from the stream/ }));
    expect(m.kick).toHaveBeenCalledWith('v1', 's', 'a', true);
    fireEvent.click(screen.getByRole('button', { name: 'Allow again' }));
    expect(m.kick).toHaveBeenCalledWith('v1', 's', 'b2', false);
    fireEvent.change(screen.getByLabelText('Viewer limit'), { target: { value: '10' } });
    expect(m.limit).toHaveBeenCalledWith('v1', 10);
    fireEvent.change(screen.getByLabelText('Viewer limit'), { target: { value: '' } });
    expect(m.limit).toHaveBeenLastCalledWith('v1', null);
  });

  it('lets a moderator with MOVE_MEMBERS remove viewers of someone else\'s stream', async () => {
    m.perms = Perm.MOVE_MEMBERS;
    render(<StreamAudience streamerId="s" />);
    fireEvent.click(screen.getByTestId('stream-viewers-button'));
    fireEvent.click(await screen.findByRole('button', { name: /Remove Bob from the stream/ }));
    expect(m.kick).toHaveBeenCalledWith('v1', 's', 'b', true);
  });

  it('says so when nobody watches', async () => {
    useData.setState({ voiceStates: { me: vs('me'), s: vs('s', { streaming: true }) } } as never);
    render(<StreamAudience streamerId="s" />);
    fireEvent.click(screen.getByTestId('stream-viewers-button'));
    expect(await screen.findByTestId('stream-no-viewers')).toBeTruthy();
  });
});

describe('viewer side: may I watch?', () => {
  it('asks the server to count me and reports ok', async () => {
    const { result } = renderHook(() => useStreamGate('v1', 's', true));
    await waitFor(() => expect(result.current.gate).toBe('ok'));
    expect(m.watch).toHaveBeenCalledWith('v1', 's', true);
  });

  it('reports a full stream with its limit, and retries on request', async () => {
    m.watch.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'STREAM_FULL', details: { limit: 3 } }));
    const { result } = renderHook(() => useStreamGate('v1', 's', true));
    await waitFor(() => expect(result.current.gate).toBe('full'));
    expect(result.current.limit).toBe(3);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.gate).toBe('ok'));
    expect(m.watch).toHaveBeenCalledTimes(2);
  });

  it('reports a removed viewer, also when the gateway says so later', async () => {
    m.watch.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'STREAM_VIEWER_KICKED' }));
    const first = renderHook(() => useStreamGate('v1', 's', true));
    await waitFor(() => expect(first.result.current.gate).toBe('kicked'));
    first.unmount();
    const second = renderHook(() => useStreamGate('v1', 's', true));
    await waitFor(() => expect(second.result.current.gate).toBe('ok'));
    act(() => useLiveVoice.getState().kick('v1', 's', 'me', true));
    expect(second.result.current.gate).toBe('kicked');
    act(() => useLiveVoice.getState().kick('v1', 's', 'me', false));
    expect(second.result.current.gate).toBe('ok');
  });

  it('tolerates other errors (older server) and stops watching shortly after the tile goes away, not at once', async () => {
    vi.useFakeTimers();
    m.watch.mockRejectedValueOnce(new Error('network'));
    const { result, unmount } = renderHook(() => useStreamGate('v1', 's', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.gate).toBe('ok');
    m.watch.mockClear();
    unmount();
    expect(m.watch).not.toHaveBeenCalled();
    // a tile for the same stream comes back in time (layout change): the viewer is never dropped
    const again = renderHook(() => useStreamGate('v1', 's', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(m.watch).toHaveBeenCalledTimes(1); expect(m.watch).toHaveBeenCalledWith('v1', 's', true);
    m.watch.mockClear();
    again.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(m.watch).toHaveBeenCalledWith('v1', 's', false);
  });

  it('does nothing while disabled (own stream, or I stopped watching)', async () => {
    renderHook(() => useStreamGate('v1', 's', false));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.watch).not.toHaveBeenCalled();
  });
});

describe('controller: server-driven media rules', () => {
  const client = () => ({ setStreamAudience: vi.fn(), setPrioritySpeakers: vi.fn() });

  it('opens the screen share to everyone until I cap the audience or remove someone', () => {
    useData.setState({ me: { id: 's' } } as never);
    const c = client();
    syncStreamAudience(c as never, 'v1');
    expect(c.setStreamAudience).toHaveBeenLastCalledWith(null);
    // a cap: only the accepted viewers (watching me) get the screen
    useData.setState({ voiceStates: { s: vs('s', { streaming: true, streamViewerLimit: 2 }), a: vs('a', { watching: 's' }), b: vs('b'), c: vs('c', { watching: 'other' }) } } as never);
    syncStreamAudience(c as never, 'v1');
    expect(c.setStreamAudience).toHaveBeenLastCalledWith(['a']);
    // a removed viewer never gets in, even if their state still says watching
    useData.setState({ voiceStates: { s: vs('s', { streaming: true }), a: vs('a', { watching: 's' }), b: vs('b', { watching: 's' }) } } as never);
    act(() => useLiveVoice.getState().kick('v1', 's', 'b', true));
    syncStreamAudience(c as never, 'v1');
    expect(c.setStreamAudience).toHaveBeenLastCalledWith(['a']);
    // not streaming / not in this channel: no restriction
    useData.setState({ voiceStates: { s: vs('s', { streaming: false }) } } as never);
    syncStreamAudience(c as never, 'v1');
    expect(c.setStreamAudience).toHaveBeenLastCalledWith(null);
    syncStreamAudience(c as never, null);
    expect(c.setStreamAudience).toHaveBeenLastCalledWith(null);
  });

  it('hands the client the server\'s priority speakers of the channel I am in', () => {
    const c = client();
    const states = { a: vs('a', { prioritySpeaker: true }), b: vs('b'), x: vs('x', { prioritySpeaker: true, channelId: 'elsewhere' }), n: vs('n', { channelId: null, prioritySpeaker: true }) };
    syncPrioritySpeakers(c as never, 'v1', states as never);
    expect(c.setPrioritySpeakers).toHaveBeenLastCalledWith(['a']);
    syncPrioritySpeakers(c as never, null, states as never);
    expect(c.setPrioritySpeakers).toHaveBeenLastCalledWith([]);
  });
});
