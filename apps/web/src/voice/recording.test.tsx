import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm, type VoiceRecording } from '@jorcord/shared';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  perms: 0n as bigint,
  snap: { channelId: 'v1' as string | null, participants: [] as Array<{ identity: string; name: string; isLocal: boolean; screenOn: boolean }> },
}));

vi.mock('@jorcord/voice/react', () => ({ useVoiceSnapshot: () => mocks.snap }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => mocks.perms }));
vi.mock('./controller', () => ({
  startCallRecording: mocks.start,
  stopCallRecording: mocks.stop,
  isDmChannel: (id: string) => id === 'dm1',
  getVoiceClient: () => ({}), joinVoice: vi.fn(), leaveVoice: vi.fn(), setPrioritySpeaker: vi.fn(), startScreenShare: vi.fn(), retryVoice: vi.fn(),
}));

import { useData } from '@/stores/data';
import { useVoiceUI } from '@/stores/voiceui';
import { RecordButton, RecordingIndicator } from './Recording';

const rec = (over: Partial<VoiceRecording> = {}): VoiceRecording => ({
  id: 'r1', channelId: 'v1', guildId: 'g1', startedBy: 'me',
  startedAt: new Date(2026, 9, 18, 12, 0, 0).toISOString(), ...over,
});

beforeEach(() => {
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.perms = Perm.RECORD_VOICE;
  mocks.snap.channelId = 'v1';
  mocks.snap.participants = [{ identity: 'me', name: 'Me', isLocal: true, screenOn: false }];
  useData.setState({ me: { id: 'me', username: 'me' }, voiceRecordings: {} } as never);
  useVoiceUI.setState({ connectedChannelId: 'v1', conn: 'connected' } as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('record button', () => {
  it('offers both modes and starts audio-only', async () => {
    render(<RecordButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(screen.getByRole('menuitem', { name: 'Audio only' })).toBeTruthy();
    expect((screen.getByRole('menuitem', { name: 'Audio + screen' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Audio only' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith('v1', 'audio'));
  });

  it('starts audio plus the active screen share when someone is sharing', async () => {
    mocks.snap.participants = [{ identity: 'me', name: 'Me', isLocal: true, screenOn: true }];
    render(<RecordButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Audio + screen' }));

    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith('v1', 'video'));
  });

  it('stops the take when this member started the recording', async () => {
    useData.setState({ voiceRecordings: { v1: rec({ startedBy: 'me' }) } } as never);
    render(<RecordButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Recording' }));

    await waitFor(() => expect(mocks.stop).toHaveBeenCalled());
  });

  it('shows a disabled indicator while someone else is recording', () => {
    useData.setState({ voiceRecordings: { v1: rec({ startedBy: 'other' }) } } as never);
    render(<RecordButton />);

    expect(screen.queryByRole('button', { name: 'Stop Recording' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Recording in progress' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is hidden without the record permission or outside a guild voice channel', () => {
    mocks.perms = 0n;
    render(<RecordButton />);
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();

    cleanup();
    mocks.perms = Perm.MANAGE_CHANNELS;
    useVoiceUI.setState({ connectedChannelId: 'dm1', conn: 'connected' } as never);
    render(<RecordButton />);
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
  });
});

describe('recording indicator', () => {
  it('stores VOICE_RECORDING_UPDATE per channel and clears it on stop', () => {
    useData.getState().apply('VOICE_RECORDING_UPDATE', { channelId: 'v1', recording: rec() });
    expect(useData.getState().voiceRecordings.v1).toMatchObject({ id: 'r1', startedBy: 'me' });

    useData.getState().apply('VOICE_RECORDING_UPDATE', { channelId: 'v1', recording: null });
    expect(useData.getState().voiceRecordings.v1).toBeUndefined();
  });

  it('is red, says Recording, and ticks the shared timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 18, 12, 0, 0));
    useData.setState({ voiceRecordings: { v1: rec() } } as never);
    render(<RecordingIndicator />);

    const banner = screen.getByTestId('voice-recording');
    expect(banner.textContent).toContain('Recording');
    expect(banner.className).toContain('bg-danger');
    expect(screen.getByTestId('voice-recording-timer').textContent).toBe('0:00');

    act(() => { vi.advanceTimersByTime(65_000); });
    expect(screen.getByTestId('voice-recording-timer').textContent).toBe('1:05');
  });

  it('renders nothing when the channel is not being recorded', () => {
    render(<RecordingIndicator />);
    expect(screen.queryByTestId('voice-recording')).toBeNull();
  });
});
