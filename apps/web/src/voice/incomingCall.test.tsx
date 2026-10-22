import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ decline: vi.fn().mockResolvedValue(undefined), startCall: vi.fn().mockResolvedValue(undefined), go: vi.fn(), plays: vi.fn(), stops: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { voice: { declineCall: m.decline } } }));
vi.mock('./DmCall', () => ({ startCall: m.startCall }));
vi.mock('@/lib/nav', () => ({ useNav: () => ({ go: m.go }) }));
vi.mock('@/lib/ringtone', () => ({ startRingLoop: () => { m.plays(); return { stop: m.stops }; } }));
import { useCalls } from '@/stores/calls';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { useData } from '@/stores/data';
import { IncomingCalls, ringAudible } from './IncomingCall';

const ring = (o: object = {}) => ({ callId: 'c1', channelId: 'dm1', userId: 'u1', name: 'Ann', channelType: 'dm' as const, groupName: null, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), silent: false, ...o });
beforeEach(() => {
  Object.values(m).forEach((f) => (f as any).mockClear?.());
  useCalls.setState({ rings: {} }); useVoiceUI.setState({ connectedChannelId: null } as never);
  useData.setState({ users: { u1: { id: 'u1', username: 'ann', displayName: 'Ann', avatar: null } } } as never);
  useUI.setState((s) => ({ prefs: { ...s.prefs, notificationSounds: true, streamerMode: false } }));
});
afterEach(cleanup);

describe('incoming call modal', () => {
  it('shows who is calling with Accept / Decline / Ignore, rings, and nothing when idle', () => {
    render(<IncomingCalls />); expect(screen.queryByTestId('incoming-call')).toBeNull(); expect(m.plays).not.toHaveBeenCalled();
    act(() => useCalls.getState().ring(ring()));
    expect(screen.getByRole('alertdialog')).toBeTruthy(); expect(screen.getByText('Ann')).toBeTruthy();
    for (const n of ['Accept', 'Decline', 'Ignore']) expect(screen.getByRole('button', { name: new RegExp(n) })).toBeTruthy();
    expect(m.plays).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Accept/ }));
  });
  it('Accept opens the DM, joins the call and stops ringing', async () => {
    render(<IncomingCalls />); act(() => useCalls.getState().ring(ring()));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Accept/ })); await Promise.resolve(); await Promise.resolve(); });
    expect(m.go).toHaveBeenCalledWith(null, 'dm1'); await vi.waitFor(() => expect(m.startCall).toHaveBeenCalledWith('dm1', false));
    expect(useCalls.getState().rings).toEqual({}); expect(m.stops).toHaveBeenCalled();
  });
  it('Decline tells the server and dismisses', () => {
    render(<IncomingCalls />); act(() => useCalls.getState().ring(ring()));
    fireEvent.click(screen.getByRole('button', { name: /Decline/ }));
    expect(m.decline).toHaveBeenCalledWith('dm1'); expect(screen.queryByTestId('incoming-call')).toBeNull();
  });
  it('Ignore (and Escape) silences this device without telling the server', () => {
    render(<IncomingCalls />); act(() => useCalls.getState().ring(ring()));
    fireEvent.click(screen.getByRole('button', { name: /Ignore/ }));
    expect(m.decline).not.toHaveBeenCalled(); expect(screen.queryByTestId('incoming-call')).toBeNull(); expect(m.stops).toHaveBeenCalled();
    act(() => useCalls.getState().ring(ring({ callId: 'c2' }))); fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByTestId('incoming-call')).toBeNull();
  });
  it('disappears when the server ends the ring or when this device joins that call', () => {
    render(<IncomingCalls />); act(() => useCalls.getState().ring(ring()));
    act(() => useCalls.getState().end('dm1', 'c1')); expect(screen.queryByTestId('incoming-call')).toBeNull();
    act(() => useCalls.getState().ring(ring({ callId: 'c3' }))); expect(screen.getByTestId('incoming-call')).toBeTruthy();
    act(() => useVoiceUI.setState({ connectedChannelId: 'dm1' } as never)); expect(screen.queryByTestId('incoming-call')).toBeNull();
  });
  it('group calls name the group and the caller', () => {
    render(<IncomingCalls />); act(() => useCalls.getState().ring(ring({ channelType: 'group_dm', groupName: 'Squad' })));
    expect(screen.getByText('Squad')).toBeTruthy(); expect(screen.getByText(/Ann started a call/)).toBeTruthy();
  });
  it('DND / sounds off / streamer mode: the invitation shows but never makes noise', () => {
    const on = { notificationSounds: true, streamerMode: false, streamerNoSounds: true };
    expect(ringAudible(ring() as never, on)).toBe(true);
    expect(ringAudible(ring({ silent: true }) as never, on)).toBe(false);
    expect(ringAudible(ring() as never, { ...on, notificationSounds: false })).toBe(false);
    expect(ringAudible(ring() as never, { ...on, streamerMode: true })).toBe(false);
    expect(ringAudible(null, on)).toBe(false);
    render(<IncomingCalls />); act(() => useCalls.getState().ring(ring({ silent: true })));
    expect(screen.getByTestId('incoming-call')).toBeTruthy(); expect(m.plays).not.toHaveBeenCalled();
  });
});
