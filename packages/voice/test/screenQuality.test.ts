import { describe, expect, it } from 'vitest';
import { LIMITS } from '@jorcord/shared';
import { CONTENT_DEFAULTS, describePlan, normalizeLock, resolveDegradation, resolveScreenPlan } from '../src/screenQuality';
import { gradeConnection, parseConnectionStats } from '../src/stats';

describe('degradation preference', () => {
  it('maps clarity/smoothness explicitly and auto by content', () => {
    expect(resolveDegradation('clarity', 'motion')).toBe('maintain-resolution');
    expect(resolveDegradation('smoothness', 'text')).toBe('maintain-framerate');
    expect(resolveDegradation('auto', 'text')).toBe('maintain-resolution');
    expect(resolveDegradation('auto', 'detail')).toBe('maintain-resolution');
    expect(resolveDegradation('auto', 'motion')).toBe('maintain-framerate');
  });
  it('has sensible per-content defaults', () => {
    expect(CONTENT_DEFAULTS.text).toMatchObject({ hint: 'text', degradation: 'clarity', fps: 30 });
    expect(CONTENT_DEFAULTS.game).toMatchObject({ hint: 'motion', degradation: 'smoothness', fps: 60 });
  });
});

describe('resolveScreenPlan (unlocked)', () => {
  it('games keep 60 fps and prefer framerate; text caps at 30 fps and prefers resolution', () => {
    const game = resolveScreenPlan({ preset: '1080p60', hint: 'motion', codec: 'h264' });
    expect(game).toMatchObject({ width: 1920, height: 1080, fps: 60, degradationPreference: 'maintain-framerate', locked: false });
    const text = resolveScreenPlan({ preset: '1080p60', hint: 'text', codec: 'h264' });
    expect(text).toMatchObject({ height: 1080, fps: 30, degradationPreference: 'maintain-resolution' });
    expect(text.maxBitrateKbps).toBeLessThan(game.maxBitrateKbps);
    // explicit smoothness on text keeps the frame rate
    expect(resolveScreenPlan({ preset: '1080p60', hint: 'text', degradation: 'smoothness', codec: 'h264' }).fps).toBe(60);
  });
  it('publishes simulcast layers below the top so slow viewers drop a layer instead of the sharer degrading', () => {
    const p = resolveScreenPlan({ preset: '4k60', hint: 'motion', codec: 'h264' });
    expect(p.layers.map((l) => l.height)).toEqual([360, 720, 1080]);
    expect(resolveScreenPlan({ preset: '720p30', hint: 'motion', codec: 'h264' }).layers.map((l) => l.height)).toEqual([360]);
  });
  it('respects mobile caps by stepping down', () => {
    const p = resolveScreenPlan({ preset: '4k60', hint: 'motion', codec: 'h264', constraints: { maxHeight: 720, maxFps: 30 } });
    expect(p.height).toBeLessThanOrEqual(720); expect(p.fps).toBeLessThanOrEqual(30); expect(p.limitedBy).toBe('platform');
  });
});

describe('manual quality lock', () => {
  it('uses exactly what was asked up to 4K60, free for everyone', () => {
    const p = resolveScreenPlan({ preset: '720p30', hint: 'motion', codec: 'h264', lock: { preset: '4k60', bitrateKbps: 30_000 } });
    expect(p).toMatchObject({ width: 3840, height: 2160, fps: 60, maxBitrateKbps: 30_000, locked: true });
    expect(LIMITS.stream.maxHeight).toBeGreaterThanOrEqual(2160);
  });
  it('fps and bitrate can be locked independently; bitrate defaults to the recommendation', () => {
    const a = resolveScreenPlan({ preset: '1080p60', hint: 'text', codec: 'vp9', lock: { preset: '1440p60', fps: 15 } });
    expect(a).toMatchObject({ height: 1440, fps: 15, locked: true });
    expect(a.maxBitrateKbps).toBeGreaterThan(150);
  });
  it('clamps to platform limits and device caps', () => {
    const big = resolveScreenPlan({ preset: '1080p60', hint: 'motion', codec: 'h264', lock: { preset: 'source', fps: 500, bitrateKbps: 10_000_000 } });
    expect(big.fps).toBeLessThanOrEqual(LIMITS.stream.maxFps); expect(big.maxBitrateKbps).toBeLessThanOrEqual(LIMITS.stream.maxBitrateKbps);
    const phone = resolveScreenPlan({ preset: '1080p60', hint: 'motion', codec: 'h264', lock: { preset: '4k60' }, constraints: { maxHeight: 1080 } });
    expect(phone.height).toBe(1080); expect(phone.limitedBy).toBe('platform');
  });
  it('rejects garbage locks', () => {
    expect(normalizeLock({ preset: 'ultra-hd' })).toBeNull();
    expect(normalizeLock(null)).toBeNull();
    expect(normalizeLock({ preset: '1080p60', fps: NaN, bitrateKbps: -5 })).toEqual({ preset: '1080p60' });
  });
  it('describes a plan for the UI', () => {
    expect(describePlan({ width: 2560, height: 1440, fps: 30, maxBitrateKbps: 12000 })).toBe('1440p · 30 fps · 12 Mbps');
    expect(describePlan({ width: 640, height: 360, fps: 30, maxBitrateKbps: 800 })).toBe('360p · 30 fps · 800 kbps');
  });
});

describe('connection grade and stats panel data', () => {
  it('grades by the worst of ping, loss and jitter and explains why', () => {
    expect(gradeConnection({ rttMs: 30, packetLossPct: 0, transport: 'udp', jitterMs: 4 })).toMatchObject({ grade: 'excellent', bars: 4, reasons: [] });
    const lossy = gradeConnection({ rttMs: 30, packetLossPct: 9, transport: 'udp' });
    expect(lossy.grade).toBe('poor'); expect(lossy.reasons[0]).toMatch(/Packet loss/);
    expect(gradeConnection({ rttMs: 320, packetLossPct: 0, transport: 'udp' }).grade).toBe('poor');
    expect(gradeConnection({ rttMs: 20, packetLossPct: 0, transport: 'udp', jitterMs: 70 }).grade).toBe('fair');
    expect(gradeConnection({ rttMs: 20, packetLossPct: 0, transport: 'relay' }).reasons.join()).toMatch(/TURN/);
    expect(gradeConnection(null).grade).toBe('unknown');
  });
  it('parses jitter, codecs and ICE path from stats reports', () => {
    const rep = new Map<string, any>(Object.entries({
      c1: { id: 'c1', type: 'codec', mimeType: 'audio/opus' }, c2: { id: 'c2', type: 'codec', mimeType: 'video/VP9' },
      a: { id: 'a', type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: 0, jitter: 0.012, bytesReceived: 1000, codecId: 'c1' },
      b: { id: 'b', type: 'outbound-rtp', kind: 'video', packetsSent: 50, bytesSent: 5000, codecId: 'c2' },
      l: { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', address: '1.2.3.4', port: 1 }, r: { id: 'r', type: 'remote-candidate', candidateType: 'host', address: '5.6.7.8', port: 2 },
      p: { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.045, localCandidateId: 'l', remoteCandidateId: 'r' },
    }));
    const { stats } = parseConnectionStats([rep], 1000);
    expect(stats).toMatchObject({ rttMs: 45, transport: 'relay', jitterMs: 12, audioCodec: 'opus', videoCodec: 'VP9' });
  });
});
