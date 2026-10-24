import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIO } from '../src/audio';
import { detectEcho, makeEchoTestSignal, measureMic, suggestFixes } from '../src/audioWizard';

const SR = 16000;
const tone = (n: number, amp: number, f = 200) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
function noise(n: number, amp: number, seed = 1) { let s = seed; return Float32Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) >>> 0; return amp * ((s / 2 ** 32) * 2 - 1); }); }
const concat = (...a: Float32Array[]) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

describe('measureMic', () => {
  it('separates noise floor from speech and detects clipping', () => {
    const clip = concat(noise(SR, 0.002), tone(SR, 0.3), noise(SR / 2, 0.002));
    const m = measureMic(clip, SR);
    expect(m.noiseFloorDb).toBeLessThan(-50); expect(m.speechDb).toBeGreaterThan(-20); expect(m.clippedPct).toBe(0);
    const hot = measureMic(tone(SR, 1.5), SR);
    expect(hot.clippedPct).toBeGreaterThan(5);
    expect(measureMic(new Float32Array(10), SR).speechDb).toBe(-120);
  });
});

describe('echo detection', () => {
  const played = makeEchoTestSignal(SR);
  it('finds the test signal delayed in the recording (echo path exists)', () => {
    const delay = Math.round(SR * 0.18);
    const rec = new Float32Array(played.length + SR); for (let i = 0; i < played.length; i++) rec[i + delay] = played[i]! * 0.3; // attenuated
    const nz = noise(rec.length, 0.002, 3); const noisy = rec.map((v, i) => v + nz[i]!);
    const r = detectEcho(played, noisy, SR);
    expect(r.detected).toBe(true); expect(r.lagMs).toBeGreaterThanOrEqual(170); expect(r.lagMs).toBeLessThanOrEqual(190);
  });
  it('does not flag room noise, speech, or silence as echo', () => {
    const len = played.length + SR;
    expect(detectEcho(played, noise(len, 0.05, 9), SR).detected).toBe(false);
    expect(detectEcho(played, new Float32Array(len), SR).detected).toBe(false);
    expect(detectEcho(played, concat(tone(SR / 2, 0.3, 150), new Float32Array(len)), SR).detected).toBe(false);
  });
});

describe('suggestFixes', () => {
  const settings = { echoCancellation: true, autoGainControl: true, noiseSuppression: true, noiseSuppressionMode: 'rnnoise' as const, noiseStrength: 'standard' as const, musicMode: false };
  const ids = (x: ReturnType<typeof suggestFixes>) => x.map((s) => s.id);
  it('reports a healthy setup', () => {
    expect(ids(suggestFixes({ settings, levels: { noiseFloorDb: -70, speechDb: -20, peakDb: -6, clippedPct: 0 }, echo: { correlation: 0, lagMs: 0, pickedUpDb: -90, detected: false } }))).toEqual(['ok']);
  });
  it('explains permission, missing and busy microphones first', () => {
    expect(suggestFixes({ settings, micError: 'denied' })[0]).toMatchObject({ id: 'perm', severity: 'fail' });
    expect(ids(suggestFixes({ settings, micError: 'not-found' }))).toContain('nomic');
    expect(ids(suggestFixes({ settings, micError: 'in-use' }))).toContain('busy');
  });
  it('flags silent, quiet, clipping and noisy input with an applicable fix', () => {
    expect(ids(suggestFixes({ settings, levels: { noiseFloorDb: -120, speechDb: -100, peakDb: -90, clippedPct: 0 } }))).toContain('silent');
    const quiet = suggestFixes({ settings: { ...settings, autoGainControl: false }, levels: { noiseFloorDb: -80, speechDb: -45, peakDb: -30, clippedPct: 0 } }).find((s) => s.id === 'quiet')!;
    expect(quiet.apply).toEqual({ autoGainControl: true });
    expect(ids(suggestFixes({ settings, levels: { noiseFloorDb: -60, speechDb: -10, peakDb: 0, clippedPct: 3 } }))).toContain('clip');
    const noisy = suggestFixes({ settings, levels: { noiseFloorDb: -35, speechDb: -15, peakDb: -3, clippedPct: 0 } }).find((s) => s.id === 'noisy')!;
    expect(noisy.apply).toMatchObject({ noiseSuppression: true, noiseStrength: 'strong' });
  });
  it('suggests headphones / echo cancellation when the speakers feed the mic', () => {
    const echo = { correlation: 0.9, lagMs: 180, pickedUpDb: -30, detected: true };
    const s = suggestFixes({ settings: { ...settings, echoCancellation: false }, echo }).find((x) => x.id === 'echo')!;
    expect(s.detail).toMatch(/headphones/); expect(s.apply).toEqual({ echoCancellation: true });
  });
  it('warns about Bluetooth microphones, music mode, a failed RNNoise and bad network numbers', () => {
    const out = suggestFixes({
      settings: { ...settings, musicMode: true }, noiseFallback: 'underrun',
      devices: { inputs: [{ id: 'a', label: 'AirPods Pro Hands-Free' }], outputs: [], selectedInputId: 'a' },
      connection: { rttMs: 400, packetLossPct: 7, transport: 'relay', jitterMs: 80 },
    });
    expect(ids(out)).toEqual(expect.arrayContaining(['bt', 'music', 'rnnoise', 'loss', 'jitter', 'ping', 'path']));
    expect(out.find((s) => s.id === 'rnnoise')!.apply).toMatchObject({ noiseSuppressionMode: 'browser', noiseStrength: 'light' });
    expect(DEFAULT_AUDIO.noiseStrength).toBe('standard');
  });
  it('sorts failures before warnings before info', () => {
    const out = suggestFixes({ settings: { ...settings, musicMode: true }, micError: 'denied', connection: { rttMs: 10, packetLossPct: 9, transport: 'udp' } });
    expect(out.map((s) => s.severity)).toEqual([...out.map((s) => s.severity)].sort((a, b) => ({ fail: 0, warn: 1, info: 2 }[a] - { fail: 0, warn: 1, info: 2 }[b])));
  });
});
