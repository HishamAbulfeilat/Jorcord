import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceUI, voiceHooks } from '@/stores/voiceui';
import { DEFAULT_SETTINGS } from '@jorcord/voice';
import { useUI } from '@/stores/ui';
import { settingsFromPrefs } from './controller';
import { MutedSpeakingHint } from './MutedHint';

beforeEach(() => { useVoiceUI.setState({ selfMute: true, selfDeaf: false, speakingWhileMuted: false, conn: 'connected' } as never); });
afterEach(() => { cleanup(); delete voiceHooks.toggleMute; });

describe('"you are muted" hint', () => {
  it('appears only when speech was detected while muted, and offers to unmute', () => {
    const toggle = vi.fn(); voiceHooks.toggleMute = toggle;
    render(<MutedSpeakingHint />);
    expect(screen.queryByTestId('muted-hint')).toBeNull();
    act(() => useVoiceUI.getState().patch({ speakingWhileMuted: true }));
    const hint = screen.getByTestId('muted-hint');
    expect(hint.getAttribute('role')).toBe('status'); expect(hint.textContent).toContain('You are muted');
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    expect(toggle).toHaveBeenCalled();
    act(() => useVoiceUI.getState().patch({ speakingWhileMuted: false }));
    expect(screen.queryByTestId('muted-hint')).toBeNull();
  });

  it('is not shown after unmuting, or while deafened', () => {
    useVoiceUI.setState({ speakingWhileMuted: true } as never);
    render(<MutedSpeakingHint />);
    expect(screen.getByTestId('muted-hint')).toBeTruthy();
    act(() => useVoiceUI.setState({ selfMute: false } as never));
    expect(screen.queryByTestId('muted-hint')).toBeNull();
    act(() => useVoiceUI.setState({ selfMute: true, selfDeaf: true } as never));
    expect(screen.queryByTestId('muted-hint')).toBeNull();
  });
});

describe('the setting', () => {
  it('is on by default and is passed to the voice client', () => {
    expect(DEFAULT_SETTINGS.mutedSpeakingHint).toBe(true);
    const prefs = useUI.getState().prefs;
    expect(prefs.mutedSpeakingHint).toBe(true);
    expect(settingsFromPrefs(prefs).mutedSpeakingHint).toBe(true);
    expect(settingsFromPrefs({ ...prefs, mutedSpeakingHint: false }).mutedSpeakingHint).toBe(false);
  });
});
