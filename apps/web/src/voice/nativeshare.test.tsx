import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const stopScreenShare = vi.fn();
const startScreenShare = vi.fn();
const snap: any = {
  status: 'connected', channelId: 'v1', cameraOn: false, screenOn: false, muted: false, deafened: false,
  platform: { canScreenShare: true, nativeScreenShare: true }, reconnect: { phase: 'idle', attempt: 0, maxAttempts: 5, nextRetryAt: null },
  connection: null, participants: [{ identity: 'me', name: 'Me', isLocal: true, quality: 'good', speaking: false, micMuted: false, cameraOn: false, screenOn: false }],
  settings: { screenPreset: '720p30', screenHint: 'motion', screenAudio: true }, error: null, screenResumeNeeded: false,
};
vi.mock('@jorcord/voice/react', () => ({
  useVoiceSnapshot: () => snap, useVoiceClient: () => ({ setCamera: vi.fn(), stopScreenShare, setLiveStreamQuality: vi.fn(), setContentHint: vi.fn(), dismissScreenResume: vi.fn() }),
  useVideoTrack: () => ({ ref: { current: null }, present: false }), useStreamStats: () => null, useAudioUnlock: () => ({ blocked: false, unlock: vi.fn() }),
}));
vi.mock('./controller', () => ({ getVoiceClient: () => ({}), joinVoice: vi.fn(), leaveVoice: vi.fn(), isDmChannel: () => false, setPrioritySpeaker: vi.fn(), startScreenShare: (...a: unknown[]) => startScreenShare(...a), retryVoice: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { guilds: { sounds: vi.fn().mockResolvedValue([]), playSound: vi.fn() } } }));
vi.mock('@/lib/useGuild', () => ({ useGuildPerms: () => 0n }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => 0n, setCurrentChannel: vi.fn() }));
vi.mock('@/lib/nav', () => ({ useNav: () => ({ go: vi.fn() }), useRouteIds: () => ({}) }));
vi.mock('@/lib/hooks', () => ({ useIsMobile: () => true }));
import { ScreenSharePopover } from './controls';
import { VoiceBanners } from './Room';

const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>;
afterEach(() => { cleanup(); snap.screenOn = false; snap.platform = { canScreenShare: true, nativeScreenShare: true }; vi.clearAllMocks(); });

describe('native (mobile) screen share UI', () => {
  it('the popover explains there is no audio, hides the audio toggle and starts a share without audio', () => {
    render(wrap(<ScreenSharePopover onClose={() => {}} />));
    expect(screen.getByTestId('share-native-note')).toBeTruthy();
    expect(screen.queryByText('Share audio')).toBeNull();
    fireEvent.click(screen.getByText('Go Live'));
    expect(startScreenShare).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
  });

  it('desktop browsers keep the audio toggle', () => {
    snap.platform = { canScreenShare: true };
    render(wrap(<ScreenSharePopover onClose={() => {}} />));
    expect(screen.queryByTestId('share-native-note')).toBeNull();
    expect(screen.getAllByText('Share audio').length).toBeGreaterThan(0);
  });

  it('shows a sharing indicator with a stop control only while a native share is live', () => {
    const { rerender } = render(wrap(<VoiceBanners />));
    expect(screen.queryByTestId('voice-native-sharing')).toBeNull();
    snap.screenOn = true;
    rerender(wrap(<VoiceBanners />));
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    expect(stopScreenShare).toHaveBeenCalled();
  });

  it('no indicator for a desktop share', () => {
    snap.screenOn = true; snap.platform = { canScreenShare: true };
    render(wrap(<VoiceBanners />));
    expect(screen.queryByTestId('voice-native-sharing')).toBeNull();
  });
});
