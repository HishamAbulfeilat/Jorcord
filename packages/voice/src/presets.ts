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
