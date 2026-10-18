import { describe, expect, it } from 'vitest';
import { cameraConstraints, cameraPlan, normalizeCameraFps, pickCodec } from '@jorcord/voice';

describe('camera quality presets', () => {
  it('auto requests 1080p30 with a 1080p -> 720p -> 480p fallback ladder', () => {
    const plan = cameraPlan('auto', 30);
    expect(plan).toMatchObject({ width: 1920, height: 1080, fps: 30, contentHint: 'motion' });
    expect(plan.attempts.map((a) => a.height)).toEqual([1080, 720, 480]);
    expect(plan.attempts[0]?.maxBitrateKbps).toBe(plan.maxBitrateKbps);
    for (const attempt of plan.attempts) expect(attempt.maxBitrateKbps).toBeGreaterThan(0);
  });

  it('pins the 720p preset without offering 1080p', () => {
    const plan = cameraPlan('720p', 30);
    expect(plan).toMatchObject({ width: 1280, height: 720, fps: 30 });
    expect(plan.attempts.map((a) => a.height)).toEqual([720, 480]);
  });

  it('honours the requested frame rate for the 1080p preset', () => {
    expect(cameraPlan('1080p', 60).fps).toBe(60);
    expect(cameraPlan('1080p', 24).fps).toBe(24);
  });

  it('normalizes stale frame-rate preferences', () => {
    expect(normalizeCameraFps(999)).toBe(60);
    expect(normalizeCameraFps(0)).toBe(30);
    expect(normalizeCameraFps(30)).toBe(30);
  });

  it('applies platform constraints and drops attempts above the cap', () => {
    const plan = cameraPlan('1080p', 60, 'h264', { maxHeight: 720, maxFps: 30 });
    expect(plan).toMatchObject({ width: 1280, height: 720, fps: 30 });
    expect(plan.attempts.map((a) => a.height)).toEqual([720, 480]);
  });

  it('keeps one clamped attempt when even 480p exceeds the constraint', () => {
    const plan = cameraPlan('auto', 30, 'h264', { maxHeight: 360 });
    expect(plan.attempts).toHaveLength(1);
    expect(plan).toMatchObject({ width: 640, height: 360 });
  });

  it('publishes simulcast layers strictly below the top layer with their own bitrate caps', () => {
    const plan = cameraPlan('1080p', 30);
    expect(plan.layers.map((l) => l.height)).toEqual([360, 720]);
    for (const layer of plan.layers) expect(layer.maxBitrateKbps).toBeLessThan(plan.maxBitrateKbps);
    expect(cameraPlan('720p', 30).layers.map((l) => l.height)).toEqual([360]);
  });

  it('bitrate follows the codec (VP9 cheaper than H264 at the same preset)', () => {
    const h264 = cameraPlan('720p', 30, 'h264').maxBitrateKbps;
    const vp9 = cameraPlan('720p', 30, 'vp9').maxBitrateKbps;
    expect(vp9).toBeLessThan(h264);
  });

  it('offers capture constraints matching the top preset', () => {
    expect(cameraConstraints('1080p', 30)).toEqual({ width: 1920, height: 1080, frameRate: 30 });
    expect(cameraConstraints('720p', 60)).toEqual({ width: 1280, height: 720, frameRate: 60 });
  });

  it('prefers VP9/AV1 and falls back to H264/VP8', () => {
    expect(pickCodec(['vp8', 'h264', 'vp9'])).toBe('vp9');
    expect(pickCodec(['vp8', 'h264'])).toBe('h264');
    expect(pickCodec(['av1', 'vp9'])).toBe('av1');
    expect(pickCodec(['vp8'])).toBe('vp8');
    expect(pickCodec(['vp8', 'h264', 'vp9'], 'h264')).toBe('h264');
  });
});
