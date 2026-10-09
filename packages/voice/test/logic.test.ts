import { describe, expect, it } from 'vitest';
import { LIMITS } from '@jorcord/shared';
import { pickCodec, recommendBitrateKbps, selectPreset, simulcastLayers, viewerQualityToDimensions, getPreset } from '../src/presets';
import { clampAudioBitrate, DEFAULT_AUDIO, resolveAudio } from '../src/audio';
import { initialSpeaking, isSpeaking, speakingReducer, speakingIds } from '../src/speaking';
import { bitrateKbps, mapConnectionQuality } from '../src/network';
import { parseVideoStats } from '../src/stats';
import { mapVoiceError } from '../src/errors';
import { effectiveVolume } from '../src/priority';
import { detectPlatform, mobileConstraints } from '../src/mobile';
import { createPushToTalk } from '../src/ptt';

describe('presets', () => {
  it('4K60 resolves to platform max and bitrate within limit', () => {
    const r = selectPreset('4k60', 'h264', 'motion');
    expect([r.width, r.height, r.fps]).toEqual([3840, 2160, 60]);
    expect(r.maxBitrateKbps).toBeLessThanOrEqual(LIMITS.stream.maxBitrateKbps);
    expect(r.maxBitrateKbps).toBeGreaterThan(25000);
  });
  it('never exceeds LIMITS even for source', () => {
    const r = selectPreset('source');
    expect(r.width).toBeLessThanOrEqual(LIMITS.stream.maxWidth);
    expect(r.fps).toBeLessThanOrEqual(LIMITS.stream.maxFps);
  });
  it('steps down on low uplink', () => {
    const r = selectPreset('4k60', 'h264', 'motion', { uplinkKbps: 10000 });
    expect(r.steppedDownFrom).toBe('4k60');
    expect(r.height).toBeLessThan(2160);
    expect(r.maxBitrateKbps).toBeLessThanOrEqual(10000 * 0.85 + 1);
  });
  it('caps mobile height/fps', () => {
    const c = mobileConstraints(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', {}));
    const r = selectPreset('1440p60', 'h264', 'motion', c);
    expect(r.height).toBeLessThanOrEqual(1080); expect(r.fps).toBeLessThanOrEqual(30);
  });
  it('720p30 is the floor', () => {
    expect(selectPreset('720p30', 'h264', 'motion', { uplinkKbps: 100 }).preset.id).toBe('720p30');
  });
  it('bitrate: av1 < vp9 < h264, motion > detail, clamped', () => {
    const f = (c: any, h: any) => recommendBitrateKbps(1920, 1080, 60, c, h);
    expect(f('av1', 'detail')).toBeLessThan(f('vp9', 'detail'));
    expect(f('vp9', 'detail')).toBeLessThan(f('h264', 'detail'));
    expect(f('h264', 'motion')).toBeGreaterThan(f('h264', 'detail'));
    expect(recommendBitrateKbps(7680, 4320, 120, 'vp8', 'motion')).toBe(LIMITS.stream.maxBitrateKbps);
    expect(recommendBitrateKbps(16, 16, 1, 'av1', 'text')).toBe(150);
  });
  it('codec pick with fallback', () => {
    expect(pickCodec(['video/VP8', 'video/H264'])).toBe('h264');
    expect(pickCodec(['av1', 'vp9', 'h264', 'vp8'])).toBe('av1');
    expect(pickCodec(['vp9', 'h264'], 'h264')).toBe('h264');
    expect(pickCodec(['vp9'], 'av1')).toBe('vp9');
    expect(pickCodec([])).toBe('vp8');
  });
  it('simulcast layers are below top and ascending', () => {
    const l = simulcastLayers(getPreset('4k60'), 'h264', 'motion');
    expect(l.map((x) => x.height)).toEqual([360, 720, 1080]);
    expect(simulcastLayers(getPreset('720p30'), 'h264', 'motion').map((x) => x.height)).toEqual([360]);
  });
  it('viewer quality', () => {
    expect(viewerQualityToDimensions('auto', { width: 1, height: 1 })).toBeNull();
    expect(viewerQualityToDimensions('low', { width: 3840, height: 2160 })).toEqual({ width: 640, height: 360 });
  });
});

describe('audio', () => {
  it('voice defaults: mono, dtx+red, processing on', () => {
    const r = resolveAudio(DEFAULT_AUDIO);
    expect(r.capture.channelCount).toBe(1); expect(r.publish.dtx && r.publish.red).toBe(true);
    expect(r.capture.echoCancellation).toBe(true);
  });
  it('music mode: stereo, processing off, no dtx, >=128kbps', () => {
    const r = resolveAudio({ ...DEFAULT_AUDIO, musicMode: true, bitrateKbps: 64 });
    expect(r.capture).toMatchObject({ channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(r.publish.forceStereo).toBe(true); expect(r.publish.dtx).toBe(false);
    expect(r.publish.audioBitrate).toBeGreaterThanOrEqual(128000);
  });
  it('clamps to 510kbps', () => {
    expect(clampAudioBitrate(9999, true)).toBe(510); expect(clampAudioBitrate(1, false)).toBe(8);
    expect(resolveAudio({ ...DEFAULT_AUDIO, musicMode: true, bitrateKbps: 9999 }).publish.audioBitrate).toBe(510000);
  });
  it('rnnoise only for mono', () => {
    expect(resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: 'rnnoise' }).useRnnoise).toBe(true);
    expect(resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: 'rnnoise', musicMode: true }).useRnnoise).toBe(false);
    expect(resolveAudio({ ...DEFAULT_AUDIO, noiseSuppressionMode: 'rnnoise' }).capture.noiseSuppression).toBe(false);
  });
});

describe('speaking reducer', () => {
  it('turns on above threshold, holds through hangover, then off', () => {
    let s = speakingReducer(initialSpeaking, { type: 'levels', now: 1000, levels: { a: 0.3, b: 0.001 } });
    expect(isSpeaking(s, 'a')).toBe(true); expect(isSpeaking(s, 'b')).toBe(false);
    s = speakingReducer(s, { type: 'levels', now: 1100, levels: { a: 0 } });
    s = speakingReducer(s, { type: 'tick', now: 1200 });
    expect(isSpeaking(s, 'a')).toBe(true); // within hangover
    s = speakingReducer(s, { type: 'tick', now: 1400 });
    expect(isSpeaking(s, 'a')).toBe(false); expect(s.speakers.a!.level).toBe(0);
  });
  it('is referentially stable when nothing changes and removes participants', () => {
    const s = speakingReducer(initialSpeaking, { type: 'levels', now: 1, levels: { a: 0.5 } });
    expect(speakingReducer(s, { type: 'tick', now: 2 })).toBe(s);
    expect(speakingIds(speakingReducer(s, { type: 'remove', id: 'a' }))).toEqual([]);
    expect(speakingReducer(s, { type: 'remove', id: 'zz' })).toBe(s);
  });
});

describe('network/stats', () => {
  it('bitrate from byte deltas', () => {
    expect(bitrateKbps(0, 0, 1_250_000, 1000)).toBe(10000);
    expect(bitrateKbps(5, 0, 1, 1000)).toBe(0);
  });
  it('maps quality', () => { expect(mapConnectionQuality('good')).toBe('good'); expect(mapConnectionQuality('x')).toBe('unknown'); });
  it('parses outbound simulcast stats picking top layer, codec, rtt', () => {
    const rep = [
      { id: 'o1', type: 'outbound-rtp', kind: 'video', rid: 'q', frameWidth: 640, frameHeight: 360, framesPerSecond: 30, bytesSent: 1000, timestamp: 2000, codecId: 'c1' },
      { id: 'o2', type: 'outbound-rtp', kind: 'video', rid: 'f', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, bytesSent: 2_000_000, timestamp: 2000, codecId: 'c1', qualityLimitationReason: 'bandwidth' },
      { id: 'c1', type: 'codec', mimeType: 'video/VP9' },
      { id: 'p', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.0234 },
    ];
    const { stats, sample } = parseVideoStats(rep, 'outbound', { bytes: 1_000_000, ts: 1000 });
    expect(stats).toMatchObject({ width: 1920, height: 1080, fps: 60, codec: 'VP9', rttMs: 23, layer: 'f', qualityLimitation: 'bandwidth' });
    expect(stats.bitrateKbps).toBe(Math.round(((2_001_000 - 1_000_000) * 8) / 1 / 1000));
    expect(sample.bytes).toBe(2_001_000);
  });
});

describe('errors/priority/ptt', () => {
  it('maps DOM errors', () => {
    expect(mapVoiceError({ name: 'NotAllowedError' }).code).toBe('permission-denied');
    expect(mapVoiceError({ name: 'NotAllowedError' }, 'screen').code).toBe('screen-cancelled');
    expect(mapVoiceError({ name: 'NotFoundError' }).code).toBe('no-device');
    expect(mapVoiceError({ name: 'NotReadableError' }).code).toBe('device-busy');
    expect(mapVoiceError(new Error('x'), 'token').code).toBe('token');
  });
  it('ducks non-priority speakers only', () => {
    const o = { isPrioritySpeakerActive: true, selfIsPriority: false, targetIsPriority: false };
    expect(effectiveVolume(1, o)).toBeCloseTo(0.3);
    expect(effectiveVolume(1, { ...o, targetIsPriority: true })).toBe(1);
    expect(effectiveVolume(5, { ...o, isPrioritySpeakerActive: false })).toBe(2);
  });
  it('push-to-talk press/release delay', async () => {
    const h: Record<string, (e: any) => void> = {};
    const target: any = { addEventListener: (k: string, f: any) => (h[k] = f), removeEventListener: () => {} };
    const calls: boolean[] = [];
    const off = createPushToTalk({ code: 'KeyV', releaseDelayMs: 20, onChange: (a) => calls.push(a), target });
    h.keydown!({ code: 'KeyV', target: {} }); h.keydown!({ code: 'KeyV', repeat: true, target: {} });
    h.keyup!({ code: 'KeyV' });
    expect(calls).toEqual([true]);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toEqual([true, false]);
    off();
  });
});
