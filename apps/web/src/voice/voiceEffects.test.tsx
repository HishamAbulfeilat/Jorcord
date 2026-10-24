import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm } from '@jorcord/shared';
import { useVoiceEffects, EFFECT_MS } from '@/stores/voiceEffects';
import { useVoiceUI } from '@/stores/voiceui';
import { onVoiceEffect } from '@/lib/soundboard';
import { TileEffects, driftFor } from './TileEffects';
import { canSetVoiceStatus } from './VoiceStatus';

beforeEach(() => { vi.useFakeTimers(); useVoiceEffects.getState().clear(); useVoiceUI.setState({ connectedChannelId: 'c1' } as never); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('emoji voice effects', () => {
  it('shows an emoji from the gateway on that user\'s tile only, then removes it', () => {
    render(<><TileEffects userId="u1" /><div data-testid="other"><TileEffects userId="u2" /></div></>);
    act(() => onVoiceEffect({ guildId: 'g', channelId: 'c1', userId: 'u1', emoji: '🎉', emojiId: null }, 'me'));
    expect(screen.getAllByTestId('voice-effect')).toHaveLength(1);
    expect(screen.getByTestId('voice-effect').textContent).toBe('🎉');
    expect(screen.getByTestId('other').querySelector('[data-testid="voice-effect"]')).toBeNull();
    act(() => { vi.advanceTimersByTime(EFFECT_MS + 300); });
    expect(screen.queryByTestId('voice-effect')).toBeNull();
  });
  it('ignores effects from a call I am not in', () => {
    onVoiceEffect({ guildId: 'g', channelId: 'other', userId: 'u1', emoji: '🔥', emojiId: null }, 'me');
    expect(useVoiceEffects.getState().effects).toHaveLength(0);
  });
  it('renders a custom emoji as an image and caps how many are alive at once', () => {
    render(<TileEffects userId="u1" />);
    act(() => onVoiceEffect({ guildId: 'g', channelId: 'c1', userId: 'u1', emoji: 'party', emojiId: '123' }, 'me'));
    const img = screen.getByTestId('voice-effect').querySelector('img')!;
    expect(img.getAttribute('src')).toContain('/emojis/123.');
    act(() => { for (let i = 0; i < 100; i++) useVoiceEffects.getState().add('u1', '👍', null); });
    expect(useVoiceEffects.getState().effects.length).toBeLessThanOrEqual(24);
  });
  it('drifts deterministically within a small range', () => {
    expect(driftFor(7)).toBe(driftFor(7));
    for (let i = 0; i < 50; i++) { const n = parseInt(driftFor(i), 10); expect(Math.abs(n)).toBeLessThanOrEqual(20); }
  });
});

describe('canSetVoiceStatus', () => {
  const ch = { id: 'c1', guildId: 'g', type: 'voice' as const };
  it('needs the permission and a connection to that very channel', () => {
    expect(canSetVoiceStatus(ch, 'c1', Perm.SET_VOICE_CHANNEL_STATUS)).toBe(true);
    expect(canSetVoiceStatus(ch, 'c1', 0n)).toBe(false);
    expect(canSetVoiceStatus(ch, 'c2', Perm.SET_VOICE_CHANNEL_STATUS)).toBe(false);
    expect(canSetVoiceStatus(ch, null, Perm.SET_VOICE_CHANNEL_STATUS)).toBe(false);
    expect(canSetVoiceStatus({ ...ch, type: 'text' as never }, 'c1', Perm.SET_VOICE_CHANNEL_STATUS)).toBe(false);
    expect(canSetVoiceStatus({ ...ch, guildId: null }, 'c1', Perm.ADMINISTRATOR)).toBe(false);
  });
});
