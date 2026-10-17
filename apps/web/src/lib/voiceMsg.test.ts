import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseMime, fmtVoiceDuration, pickVoiceMime, waveformPeaks, voiceFilename } from './voiceMsg';

const MR = (want: (m: string) => boolean) => class { static isTypeSupported = (m: string) => want(m) };

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).MediaRecorder; });

describe('voiceMsg helpers', () => {
  it('prefers opus in webm and falls back through the supported list', () => {
    const order: string[] = [];
    (globalThis as unknown as Record<string, unknown>).MediaRecorder = class {
      static isTypeSupported(m: string) { order.push(m); return m === 'audio/webm'; } // only the bare container wins
    };
    expect(pickVoiceMime()).toBe('audio/webm');
    expect(order[0]).toBe('audio/webm;codecs=opus'); // best is tried first
  });

  it('says so when nothing is supported (and when MediaRecorder is missing)', () => {
    (globalThis as unknown as Record<string, unknown>).MediaRecorder = MR(() => false);
    expect(pickVoiceMime()).toBeNull();
    expect(pickVoiceMime()).toBeNull();
    delete (globalThis as unknown as Record<string, unknown>).MediaRecorder;
    expect(pickVoiceMime()).toBeNull();
  });

  it('strips codecs for the bare container mime and defaults safely', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('audio/mp4;codecs=mp4a.40.5')).toBe('audio/mp4');
    expect(baseMime('')).toBe('audio/webm');
  });

  it('names voice files like Discord does', () => {
    expect(voiceFilename(new Date(2026, 9, 17, 9, 5))).toBe('voice-message-2026-10-17-0905.webm');
  });

  it('formats m:ss durations, rounding half seconds up', () => {
    expect(fmtVoiceDuration(0)).toBe('0:00');
    expect(fmtVoiceDuration(95.4)).toBe('1:35');
    expect(fmtVoiceDuration(65.6)).toBe('1:06');
    expect(fmtVoiceDuration(-3)).toBe('0:00');
  });

  it('downsamples audio into fixed bar peaks', () => {
    expect(waveformPeaks([0.1, -0.9, 0.2, 0.5, -0.4, 0.3], 2)).toEqual([0.9, 0.5]);
    expect(waveformPeaks(new Float32Array(0), 3)).toEqual([0, 0, 0]);
    expect(waveformPeaks([0.5], 0)).toEqual([]);
  });
});

describe('MediaRecorder.isTypeSupported quirk', () => {
  it('is tolerated if it throws', () => {
    (globalThis as unknown as Record<string, unknown>).MediaRecorder = class { static isTypeSupported = () => { throw new Error('nope'); }; };
    expect(pickVoiceMime()).toBeNull();
  });
});
