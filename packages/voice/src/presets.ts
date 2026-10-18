import { LIMITS } from '@jorcord/shared';

export type VideoCodecName = 'av1' | 'vp9' | 'h264' | 'vp8';
export type ContentHint = 'motion' | 'detail' | 'text';
export type StreamPresetId = '720p30' | '1080p60' | '1440p60' | '4k60' | 'source';

export interface StreamPreset {
  id: StreamPresetId;
  label: string;
  width: number;
  height: number;
  fps: number;
}

/** Selectable stream qualities. `source` = as high as LIMITS allows (capture-native, clamped). */
export const STREAM_PRESETS: readonly StreamPreset[] = [
  { id: '720p30', label: '720p 30fps', width: 1280, height: 720, fps: 30 },
  { id: '1080p60', label: '1080p 60fps', width: 1920, height: 1080, fps: 60 },
  { id: '1440p60', label: '1440p 60fps', width: 2560, height: 1440, fps: 60 },
  { id: '4k60', label: '4K 60fps', width: 3840, height: 2160, fps: 60 },
  { id: 'source', label: 'Source', width: LIMITS.stream.maxWidth, height: LIMITS.stream.maxHeight, fps: LIMITS.stream.maxFps },
];

/** Simulcast ladder (lowest -> highest). Only layers strictly below the top are published as extra layers. */
export const SIMULCAST_LADDER = [
  { width: 640, height: 360, fps: 30 },
  { width: 1280, height: 720, fps: 30 },
  { width: 1920, height: 1080, fps: 60 },
  { width: 3840, height: 2160, fps: 60 },
] as const;

export function getPreset(id: StreamPresetId): StreamPreset {
  return STREAM_PRESETS.find((p) => p.id === id) ?? STREAM_PRESETS[1]!;
}

/** Clamp any resolution/fps to the global platform limits. */
export function clampToLimits<T extends { width: number; height: number; fps: number }>(r: T): T {
  return {
    ...r,
    width: Math.min(r.width, LIMITS.stream.maxWidth),
    height: Math.min(r.height, LIMITS.stream.maxHeight),
    fps: Math.min(r.fps, LIMITS.stream.maxFps),
  };
}

export interface PresetConstraints {
  /** e.g. mobile browsers: cap the height. */
  maxHeight?: number;
  maxFps?: number;
  /** Measured/estimated uplink in kbps. Preset is stepped down until it fits. */
  uplinkKbps?: number;
  /** Whether the user's plan/permission allows HD (>1080p). */
  allowHd?: boolean;
}

const BPP: Record<VideoCodecName, number> = { h264: 0.08, vp8: 0.085, vp9: 0.055, av1: 0.045 };

/** Recommended max bitrate (kbps) for a resolution/fps/codec; never exceeds LIMITS.stream.maxBitrateKbps. */
export function recommendBitrateKbps(
  width: number, height: number, fps: number,
  codec: VideoCodecName = 'h264', hint: ContentHint = 'motion',
): number {
  const hintMul = hint === 'motion' ? 1.25 : hint === 'text' ? 0.8 : 1;
  const raw = (width * height * fps * BPP[codec] * hintMul) / 1000;
  // 4K60 h264 detail is the reference upper bound (~40 Mbps)
  return Math.max(150, Math.min(LIMITS.stream.maxBitrateKbps, Math.round(raw)));
}

export interface ResolvedStream {
  preset: StreamPreset;
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number;
  /** presets that were skipped because of constraints, highest first. */
  steppedDownFrom?: StreamPresetId;
}

/**
 * Pick the best preset not exceeding the requested id that satisfies all constraints.
 * Steps down through STREAM_PRESETS (excluding `source` unless requested).
 */
export function selectPreset(
  requested: StreamPresetId,
  codec: VideoCodecName = 'h264',
  hint: ContentHint = 'motion',
  c: PresetConstraints = {},
): ResolvedStream {
  const ladder = STREAM_PRESETS.filter((p) => p.id !== 'source' || requested === 'source');
  let idx = ladder.findIndex((p) => p.id === requested);
  if (idx < 0) idx = 1;
  const fits = (p: StreamPreset) => {
    const q = clampToLimits({ ...p });
    if (c.maxHeight && q.height > c.maxHeight) return false;
    if (c.allowHd === false && q.height > 1080) return false;
    if (c.uplinkKbps && recommendBitrateKbps(q.width, q.height, Math.min(q.fps, c.maxFps ?? q.fps), codec, hint) > c.uplinkKbps * 0.85) return false;
    return true;
  };
  let i = idx;
  while (i > 0 && !fits(ladder[i]!)) i--;
  const preset = ladder[i]!;
  const q = clampToLimits({ ...preset });
  let h = q.height, w = q.width;
  if (c.maxHeight && h > c.maxHeight) { w = Math.round((w * c.maxHeight) / h); h = c.maxHeight; }
  const fps = Math.min(q.fps, c.maxFps ?? q.fps);
  return {
    preset, width: w, height: h, fps,
    maxBitrateKbps: recommendBitrateKbps(w, h, fps, codec, hint),
    steppedDownFrom: i !== idx ? ladder[idx]!.id : undefined,
  };
}

/** Pick a codec from what the browser supports. Order favours efficiency (AV1 > VP9 > H264 > VP8). */
export function pickCodec(supported: readonly string[], preferred?: VideoCodecName | 'auto'): VideoCodecName {
  const has = (c: string) => supported.some((s) => s.toLowerCase().replace('video/', '') === c);
  if (preferred && preferred !== 'auto' && has(preferred)) return preferred;
  for (const c of ['av1', 'vp9', 'h264', 'vp8'] as const) if (has(c)) return c;
  return 'vp8';
}

export function isScalableCodec(c: VideoCodecName): boolean { return c === 'vp9' || c === 'av1'; }

/** Codec list from RTCRtpSender capabilities (safe outside the browser). */
export function detectSupportedVideoCodecs(): string[] {
  try {
    const caps = (globalThis as any).RTCRtpSender?.getCapabilities?.('video');
    return Array.from(new Set<string>((caps?.codecs ?? []).map((c: any) => String(c.mimeType).toLowerCase().replace('video/', ''))));
  } catch { return []; }
}

export interface Layer { width: number; height: number; fps: number; maxBitrateKbps: number }

/** Simulcast layers below the top layer (lowest -> highest), with bitrate caps. */
export function simulcastLayers(top: { width: number; height: number; fps: number }, codec: VideoCodecName, hint: ContentHint): Layer[] {
  return SIMULCAST_LADDER
    .filter((l) => l.height < top.height)
    .map((l) => ({ ...l, fps: Math.min(l.fps, top.fps), maxBitrateKbps: recommendBitrateKbps(l.width, l.height, Math.min(l.fps, top.fps), codec, hint) }));
}

/**
 * Camera quality presets. `auto` asks for 1080p and steps down to 720p then 480p when the device or uplink
 * cannot provide it; the fixed presets start at their own step of the same ladder.
 */
export type CameraQuality = 'auto' | '720p' | '1080p';
export const CAMERA_FRAME_RATES = [15, 24, 30, 60] as const;
export type CameraFrameRate = (typeof CAMERA_FRAME_RATES)[number];
export const CAMERA_MAX_FPS = 60;

/** Capture ladder used for camera: highest first, so a failed/oversized request can fall back gracefully. */
const CAMERA_LADDER = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
] as const;

/** Keep a requested frame rate usable (1..60) even if a stored preference is stale. */
export function normalizeCameraFps(fps: number): number {
  return Math.min(CAMERA_MAX_FPS, Math.max(1, Math.round(fps || 30)));
}

export interface CameraCaptureConstraints { width: number; height: number; frameRate: number }

/** Requested capture constraints for a camera quality/frame rate pair (highest attempt, platform-clamped). */
export function cameraConstraints(quality: CameraQuality, fps = 30, c: PresetConstraints = {}): CameraCaptureConstraints {
  const target = quality === '720p' ? 1 : 0;
  const l: { width: number; height: number } = CAMERA_LADDER[target]!;
  const q = clampToLimits({ width: l.width, height: l.height, fps: Math.min(normalizeCameraFps(fps), c.maxFps ?? CAMERA_MAX_FPS) });
  let width = q.width, height = q.height;
  const maxH = c.maxHeight ?? height;
  if (height > maxH) { width = Math.round((width * maxH) / height); height = maxH; }
  return { width, height, frameRate: q.fps };
}

export interface CameraEncoding { width: number; height: number; fps: number; maxBitrateKbps: number; layers: Layer[] }

export interface CameraPlan extends CameraEncoding {
  quality: CameraQuality;
  /** Camera video is always encoded for motion (people), not screen detail. */
  contentHint: 'motion';
  /** Capture attempts from highest to lowest (1080p -> 720p -> 480p), each with its own bitrate/layers. */
  attempts: CameraEncoding[];
}

/**
 * Pure camera preset -> capture constraints, bitrate and simulcast layers.
 * `attempts` is what the publisher tries in order; the first entry is the requested top quality.
 */
export function cameraPlan(quality: CameraQuality, fps = 30, codec: VideoCodecName = 'h264', c: PresetConstraints = {}): CameraPlan {
  const start = quality === '720p' ? 1 : 0;
  const frameRate = Math.min(normalizeCameraFps(fps), c.maxFps ?? CAMERA_MAX_FPS);
  const attempts: CameraEncoding[] = [];
  for (let i = start; i < CAMERA_LADDER.length; i++) {
    const l = CAMERA_LADDER[i]!;
    if (c.maxHeight && l.height > c.maxHeight) continue;
    const encoding = { width: l.width, height: l.height, fps: frameRate, maxBitrateKbps: recommendBitrateKbps(l.width, l.height, frameRate, codec, 'motion') };
    attempts.push({ ...encoding, layers: simulcastLayers(encoding, codec, 'motion') });
  }
  // Constraints below 480p (or an unsupported combination): keep one clamped attempt.
  if (!attempts.length) {
    const cc = cameraConstraints(quality, frameRate, c);
    const encoding = { width: cc.width, height: cc.height, fps: cc.frameRate, maxBitrateKbps: recommendBitrateKbps(cc.width, cc.height, cc.frameRate, codec, 'motion') };
    attempts.push({ ...encoding, layers: simulcastLayers(encoding, codec, 'motion') });
  }
  const top = attempts[0]!;
  return { quality, contentHint: 'motion', ...top, attempts };
}

/**
 * Camera codecs follow the global preference order (AV1 > VP9 > H264 > VP8): VP9/AV1 are used when the browser
 * can encode them, with H264/VP8 as the fallback.
 */

/** Viewer-side quality choice. */
export type ViewerQuality = 'auto' | 'low' | 'medium' | 'high';
export function viewerQualityToDimensions(q: ViewerQuality, top: { width: number; height: number }): { width: number; height: number } | null {
  switch (q) {
    case 'auto': return null;
    case 'low': return { width: 640, height: 360 };
    case 'medium': return { width: 1280, height: 720 };
    case 'high': return { width: top.width, height: top.height };
  }
}
