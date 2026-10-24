import { LIMITS } from '@jorcord/shared';
import {
  STREAM_PRESETS, clampToLimits, getPreset, recommendBitrateKbps, selectPreset, simulcastLayers,
  type ContentHint, type Layer, type PresetConstraints, type StreamPresetId, type VideoCodecName,
} from './presets';

/**
 * Screen-share quality controls. Everything here is free (no tier gates): resolution and frame rate go up to 4K60 / `source`,
 * limited only by the global platform LIMITS.
 *
 *  - degradation: what the encoder gives up first when the uplink or CPU runs short.
 *      'clarity'    = keep resolution, drop frames  (slides, code, documents, text)
 *      'smoothness' = keep frame rate, drop resolution (games, video, motion)
 *      'auto'       = pick from the content type
 *  - lock: a manual quality lock (resolution / fps / bitrate). A locked share is never stepped down by the adaptive governor
 *    (see adaptation.ts); viewers on slow links get a lower simulcast layer instead of the sharer degrading.
 */
export type DegradationChoice = 'auto' | 'clarity' | 'smoothness';
export type DegradationPreference = 'maintain-resolution' | 'maintain-framerate';

export const DEGRADATION_CHOICES: readonly { id: DegradationChoice; label: string; hint: string }[] = [
  { id: 'auto', label: 'Automatic', hint: 'Clarity for text and slides, smoothness for games and video.' },
  { id: 'clarity', label: 'Prefer clarity', hint: 'Keeps the picture sharp and lowers the frame rate when the connection is tight.' },
  { id: 'smoothness', label: 'Prefer smoothness', hint: 'Keeps motion fluid and lowers the resolution when the connection is tight.' },
];

export function resolveDegradation(choice: DegradationChoice, hint: ContentHint): DegradationPreference {
  if (choice === 'clarity') return 'maintain-resolution';
  if (choice === 'smoothness') return 'maintain-framerate';
  return hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
}

export interface ContentDefaults { hint: ContentHint; degradation: DegradationChoice; preset: StreamPresetId; fps: number; label: string }
/** Sensible starting points per kind of content; the user can override each part. */
export const CONTENT_DEFAULTS: Record<'text' | 'game', ContentDefaults> = {
  text: { hint: 'text', degradation: 'clarity', preset: '1440p60', fps: 30, label: 'Text, slides, code' },
  game: { hint: 'motion', degradation: 'smoothness', preset: '1080p60', fps: 60, label: 'Game or video' },
};

/** Named bitrate steps for the manual lock (kbps). `auto` = derived from resolution, fps, codec. */
export const BITRATE_STEPS = [
  { id: 'auto', label: 'Auto', kbps: 0 },
  { id: 'low', label: '2.5 Mbps', kbps: 2_500 },
  { id: 'medium', label: '6 Mbps', kbps: 6_000 },
  { id: 'high', label: '12 Mbps', kbps: 12_000 },
  { id: 'ultra', label: '25 Mbps', kbps: 25_000 },
  { id: 'max', label: `${Math.round(LIMITS.stream.maxBitrateKbps / 1000)} Mbps`, kbps: LIMITS.stream.maxBitrateKbps },
] as const;
export const LOCK_FPS_CHOICES = [15, 24, 30, 60] as const;

export interface QualityLock {
  preset: StreamPresetId;
  /** Frame rate cap; defaults to the preset's. */
  fps?: number;
  /** Bitrate cap in kbps; omitted/0 = automatic for the resolution. */
  bitrateKbps?: number;
}

/** Sanitises a stored or user-edited lock (unknown preset -> null, fps/bitrate clamped to the platform limits). */
export function normalizeLock(l: unknown): QualityLock | null {
  if (!l || typeof l !== 'object') return null;
  const o = l as Record<string, unknown>;
  if (!STREAM_PRESETS_IDS.has(o.preset as StreamPresetId)) return null;
  const fps = typeof o.fps === 'number' && Number.isFinite(o.fps) ? Math.min(LIMITS.stream.maxFps, Math.max(1, Math.round(o.fps))) : undefined;
  const kbps = typeof o.bitrateKbps === 'number' && Number.isFinite(o.bitrateKbps) && o.bitrateKbps > 0 ? Math.min(LIMITS.stream.maxBitrateKbps, Math.max(150, Math.round(o.bitrateKbps))) : undefined;
  return { preset: o.preset as StreamPresetId, ...(fps ? { fps } : {}), ...(kbps ? { bitrateKbps: kbps } : {}) };
}
const STREAM_PRESETS_IDS = new Set<StreamPresetId>(['720p30', '1080p60', '1440p60', '4k60', 'source']);

export interface ScreenPlan {
  width: number; height: number; fps: number; maxBitrateKbps: number;
  degradationPreference: DegradationPreference;
  /** Simulcast layers below the top one: slow viewers drop to these instead of the sharer degrading. */
  layers: Layer[];
  locked: boolean;
  /** Set when the platform (mobile) forced a lower value than requested. */
  limitedBy?: 'platform';
}

export interface ScreenPlanInput {
  preset: StreamPresetId; hint: ContentHint; degradation?: DegradationChoice; lock?: QualityLock | null;
  codec: VideoCodecName; constraints?: PresetConstraints;
}

/**
 * Pure: settings -> capture constraints, encoder caps, degradation preference and simulcast ladder.
 * Unlocked: the preset is stepped down through selectPreset when the platform requires it, and text content is capped at 30 fps
 * (sharper frames for the same bitrate) when the clarity mode is in effect.
 * Locked: the requested resolution / fps / bitrate are used as they are (still clamped to platform limits and device caps).
 */
export function resolveScreenPlan(i: ScreenPlanInput): ScreenPlan {
  const lock = normalizeLock(i.lock);
  const deg = resolveDegradation(i.degradation ?? 'auto', i.hint);
  const c = i.constraints ?? {};
  if (!lock) {
    const r = selectPreset(i.preset, i.codec, i.hint, c);
    let fps = r.fps;
    if (i.hint === 'text' && deg === 'maintain-resolution') fps = Math.min(fps, 30);
    const bitrate = fps === r.fps ? r.maxBitrateKbps : recommendBitrateKbps(r.width, r.height, fps, i.codec, i.hint);
    return { width: r.width, height: r.height, fps, maxBitrateKbps: bitrate, degradationPreference: deg, layers: simulcastLayers({ width: r.width, height: r.height, fps }, i.codec, i.hint), locked: false, ...(r.steppedDownFrom ? { limitedBy: 'platform' as const } : {}) };
  }
  const p = getPreset(lock.preset);
  const q = clampToLimits({ width: p.width, height: p.height, fps: lock.fps ?? p.fps });
  let { width, height } = q; let fps = q.fps; let limited = false;
  if (c.maxHeight && height > c.maxHeight) { width = Math.round((width * c.maxHeight) / height); height = c.maxHeight; limited = true; }
  if (c.maxFps && fps > c.maxFps) { fps = c.maxFps; limited = true; }
  const auto = recommendBitrateKbps(width, height, fps, i.codec, i.hint);
  const bitrate = Math.min(LIMITS.stream.maxBitrateKbps, Math.max(150, lock.bitrateKbps ?? auto));
  return { width, height, fps, maxBitrateKbps: bitrate, degradationPreference: deg, layers: simulcastLayers({ width, height, fps }, i.codec, i.hint), locked: true, ...(limited ? { limitedBy: 'platform' as const } : {}) };
}

/** One-line description for the UI ("1440p · 30 fps · 12 Mbps"). */
export function describePlan(p: Pick<ScreenPlan, 'width' | 'height' | 'fps' | 'maxBitrateKbps'>): string {
  const br = p.maxBitrateKbps >= 1000 ? `${(p.maxBitrateKbps / 1000).toFixed(p.maxBitrateKbps % 1000 ? 1 : 0)} Mbps` : `${p.maxBitrateKbps} kbps`;
  return `${p.height}p · ${p.fps} fps · ${br}`;
}
