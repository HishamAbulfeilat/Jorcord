import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoicePlayer } from './Attachments';

vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))); // waveforms fall back to flat bars

beforeEach(() => { vi.mocked(fetch).mockClear(); });
afterEach(cleanup);

describe('VoicePlayer', () => {
  it('starts playback through the real media element and label flips to Pause; pausing goes back', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    render(<VoicePlayer src="https://cdn/voice.webm" />);
    const toggle = screen.getByTestId('voice-player-play');
    expect(toggle.getAttribute('aria-label')).toBe('Play');
    fireEvent.click(toggle);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    fireEvent.play(screen.getByTestId('voice-player-audio')); // the element confirms
    expect(toggle.getAttribute('aria-label')).toBe('Pause');
    fireEvent.click(toggle);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  });

  it('cycles playback speed 1x -> 1.5x -> 2x -> 1x and sets it on the element', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    render(<VoicePlayer src="https://cdn/voice.webm" />);
    const audio = screen.getByTestId('voice-player-audio') as HTMLAudioElement;
    const speed = screen.getByTestId('voice-player-speed');
    expect(speed.textContent).toBe('1x');
    fireEvent.click(speed);
    expect(speed.textContent).toBe('1.5x');
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(speed);
    expect(speed.textContent).toBe('2x');
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(speed);
    expect(speed.textContent).toBe('1x');
    expect(audio.playbackRate).toBe(1);
  });

  it('highlights waveform bars behind the playhead as timeupdate arrives', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    render(<VoicePlayer src="https://cdn/voice.webm" />);
    const audio = screen.getByTestId('voice-player-audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { value: 60, configurable: true });
    fireEvent(screen.getByTestId('voice-player-audio'), new Event('loadedmetadata'));
    expect(screen.getByTestId('voice-player-duration').textContent).toBe('1:00');
    Object.defineProperty(audio, 'currentTime', { value: 30, configurable: true });
    fireEvent.timeUpdate(audio);
    const bars = screen.getByTestId('waveform').querySelectorAll('span');
    expect(bars.length).toBe(40);
    expect([...bars].filter((b) => b.style.opacity === '1')).toHaveLength(20); // half played, half not
  });

  it('shows a flat waveform when the audio cannot be decoded', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    render(<VoicePlayer src="https://cdn/voice.webm" />);
    const bars = screen.getByTestId('waveform').querySelectorAll('span');
    expect(bars.length).toBe(40); // flat-but-alive fallback, no crash
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://cdn/voice.webm');
  });
});
