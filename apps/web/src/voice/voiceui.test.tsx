import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const snap: any = {
  status: 'connected', channelId: 'v1', cameraOn: false, screenOn: false, muted: false, deafened: false,
  platform: { canScreenShare: true }, reconnect: { phase: 'idle', attempt: 0, maxAttempts: 5, nextRetryAt: null },
  connection: { rttMs: 42, packetLossPct: 3 }, participants: [{ identity: 'me', name: 'Me', isLocal: true, quality: 'good', speaking: false, micMuted: false, cameraOn: false, screenOn: false }], settings: {}, error: null,
};
vi.mock('@jorcord/voice/react', () => ({
  useVoiceSnapshot: () => snap, useVoiceClient: () => ({ setCamera: vi.fn().mockResolvedValue(undefined), stopScreenShare: vi.fn() }),
  useVideoTrack: () => ({ ref: { current: null }, present: false }), useStreamStats: () => null, useAudioUnlock: () => ({ blocked: false, unlock: vi.fn() }),
}));
vi.mock('./controller', () => ({ getVoiceClient: () => ({ setCamera: vi.fn().mockResolvedValue(undefined), stopScreenShare: vi.fn() }), joinVoice: vi.fn(), leaveVoice: vi.fn(), isDmChannel: () => false, setPrioritySpeaker: vi.fn(), startScreenShare: vi.fn(), retryVoice: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { guilds: { sounds: vi.fn().mockResolvedValue([]), playSound: vi.fn() } } }));
vi.mock('@/lib/useGuild', () => ({ useGuildPerms: () => 0n }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => 0n, setCurrentChannel: vi.fn() }));
vi.mock('@/lib/nav', () => ({ useNav: () => ({ go: vi.fn() }), useRouteIds: () => ({}) }));
vi.mock('@/lib/hooks', () => ({ useIsMobile: () => false }));
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { VoiceDock } from './views';
import { ControlBar } from './controls';
import { CallSurface } from './Room';

const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>;
beforeEach(() => {
  useData.setState({ me: { id: 'me', username: 'me' }, users: {}, guilds: { g1: { guild: { id: 'g1', name: 'G' }, channels: { v1: { id: 'v1', guildId: 'g1', type: 'voice', name: 'Lobby' } }, members: {}, roles: {}, emojis: [] } }, dms: {}, voiceStates: {} } as never);
  useVoiceUI.setState({ conn: 'connected', connectedChannelId: 'v1' } as never);
  useUI.getState().setPref('showVoiceStats', true);
});
afterEach(cleanup);

describe('Voice Connected dock buttons', () => {
  it('every button in the row is an icon (no squeezed text) with an aria-label and a tooltip', () => {
    render(wrap(<VoiceDock />));
    for (const id of ['dock-camera', 'dock-golive', 'dock-soundboard', 'dock-settings']) {
      const b = screen.getByTestId(id);
      expect(b.querySelector('svg'), id).toBeTruthy();
      expect(b.getAttribute('aria-label'), id).toBeTruthy();
      expect(b.textContent, id).toBe('');
      expect(b.className).toContain('h-8');
    }
    expect(screen.getAllByRole('tooltip', { hidden: true }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId('dock-golive').getAttribute('aria-label')).toBe('Share Your Screen');
  });
});

describe('connection status toggle', () => {
  it('the activity button hides and shows the status strip and the dock ping, and remembers the choice', () => {
    render(wrap(<><ControlBar onSettings={() => {}} /><CallSurface /><VoiceDock /></>));
    expect(screen.getByTestId('connection-status').textContent).toContain('42 ms');
    expect(screen.getByTestId('voice-dock-ping')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Connection Stats' }));
    expect(screen.queryByTestId('connection-status')).toBeNull();
    expect(screen.queryByTestId('voice-dock-ping')).toBeNull();
    expect(useUI.getState().prefs.showVoiceStats).toBe(false);
    expect(JSON.parse(localStorage.getItem('jorcord.prefs.v1') ?? '{}').showVoiceStats).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show Connection Stats' }));
    expect(screen.getByTestId('connection-status')).toBeTruthy();
  });
});
