import { describe, it, expect } from 'vitest';
import { noiseStatusText } from './noiseStatus';

describe('noiseStatusText', () => {
  it('warns with the reason when RNNoise fell back', () => {
    const r = noiseStatusText('rnnoise', { musicMode: false, fallback: 'unsupported' });
    expect(r.tone).toBe('warn'); expect(r.text).toMatch(/AudioWorklet/); expect(r.text).toMatch(/browser's built-in/);
  });
  it('does not warn for modes that never use RNNoise, even with a stale fallback', () => {
    expect(noiseStatusText('browser', { musicMode: false, fallback: 'load-failed' }).tone).toBe('info');
    expect(noiseStatusText('off', { musicMode: false, fallback: 'load-failed' }).text).toMatch(/No noise/);
  });
  it('explains music mode', () => { expect(noiseStatusText('high', { musicMode: true, fallback: null }).text).toMatch(/Music mode/); });
});
