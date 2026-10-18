/**
 * Local self-view post-processing with no extra dependency: the preview is painted through a 2D canvas, so
 * `ctx.filter` can soften the frame (blur) and apply a small exposure correction derived from the average
 * luminance. Nothing leaves the tab, processing is opt-in and capped at 12 fps, and it stops entirely while
 * the tab is hidden. (A true background cut-out would need MediaPipe/segmentation: not shipped.)
 */

export interface CameraEffectPrefs {
  /** Soft-focus blur of the local preview. */
  blur: boolean;
  /** Brightness/contrast nudge when the frame is too dark or too bright. */
  autoAdjust: boolean;
}

export const MAX_EFFECT_FPS = 12;
export const BLUR_PX = 6;
const MIN_FRAME_MS = Math.ceil(1000 / MAX_EFFECT_FPS);
const LUMA_INTERVAL_MS = 1500;
const SAMPLE_W = 32;
const SAMPLE_H = 18;

export function effectsEnabled(e: CameraEffectPrefs): boolean { return e.blur || e.autoAdjust; }

/** Canvas 2D `filter` support (missing in older iOS Safari and some embedded webviews). */
export function isCanvasFilterSupported(proto?: { filter?: unknown } | null): boolean {
  try {
    const p = proto ?? (typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null);
    return !!p && 'filter' in p;
  } catch { return false; }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Exposure correction for a 0-255 average luma; a wide dead band keeps the picture stable. */
export function autoAdjustFilter(luma: number | null | undefined): string {
  if (luma == null || !Number.isFinite(luma)) return '';
  const v = Math.max(0, Math.min(255, luma));
  if (v < 96) return `brightness(${round2(Math.min(1.35, 1 + ((96 - v) / 96) * 0.35))}) contrast(1.05)`;
  if (v > 176) return `brightness(${round2(Math.max(0.75, 1 - ((v - 176) / 79) * 0.25))}) contrast(1.05)`;
  return '';
}

/** CSS filter string for the canvas: blur first, then the exposure nudge. */
export function composeFilter(e: CameraEffectPrefs, luma: number | null = null): string {
  const parts: string[] = [];
  if (e.blur) parts.push(`blur(${BLUR_PX}px)`);
  if (e.autoAdjust) { const a = autoAdjustFilter(luma); if (a) parts.push(a); }
  return parts.join(' ');
}

/** Skip all work when there is nothing to do, the frame is not ready, or the tab is in the background. */
export function shouldProcess(o: { visible: boolean; effects: CameraEffectPrefs; readyState?: number; width?: number; height?: number }): boolean {
  return o.visible && effectsEnabled(o.effects) && (o.readyState ?? 2) >= 2 && (o.width ?? 1) > 0 && (o.height ?? 1) > 0;
}

/** Average luminance of RGBA pixels, sampling at most ~512 pixels so it stays cheap. */
export function averageLuma(rgba: ArrayLike<number>): number | null {
  const px = Math.floor(rgba.length / 4);
  if (!px) return null;
  const step = Math.max(1, Math.floor(px / 512));
  let sum = 0; let n = 0;
  for (let i = 0; i < px; i += step) {
    const o = i * 4;
    sum += 0.2126 * (rgba[o] ?? 0) + 0.7152 * (rgba[o + 1] ?? 0) + 0.0722 * (rgba[o + 2] ?? 0);
    n++;
  }
  return n ? sum / n : null;
}

interface VideoLike { videoWidth: number; videoHeight: number; readyState: number }
interface CanvasLike { width: number; height: number; getContext(id: '2d'): any }

export interface SelfViewPaintOptions {
  video: VideoLike;
  canvas: CanvasLike;
  effects: () => CameraEffectPrefs;
  /** Overridable for tests; defaults to `document.hidden`. */
  hidden?: () => boolean;
  now?: () => number;
}

const tabHidden = () => typeof document !== 'undefined' && document.hidden === true;

/**
 * Paints the local preview into a canvas while effects are on. One instance per self-view; `start()` returns
 * its own stop function. Frames are throttled and dropped when hidden, so an idle tab costs nothing.
 */
export class SelfViewPainter {
  private handle: number | null = null;
  private lastFrame = 0;
  private lastLumaAt = 0;
  private luma: number | null = null;
  private sample: any = null;

  constructor(private readonly o: SelfViewPaintOptions) {}

  start(): () => void {
    this.stop();
    this.lastFrame = 0;
    const loop = () => { this.frame(); this.handle = requestAnimationFrame(loop); };
    this.handle = requestAnimationFrame(loop);
    return () => this.stop();
  }

  stop(): void {
    if (this.handle != null) { cancelAnimationFrame(this.handle); this.handle = null; }
  }

  /** One throttled frame; returns true when it actually painted. */
  frame(now?: number, hidden?: boolean): boolean {
    const t = now ?? (this.o.now ? this.o.now() : performance.now());
    const away = hidden ?? (this.o.hidden ? this.o.hidden() : tabHidden());
    const fx = this.o.effects();
    const v = this.o.video;
    if (!shouldProcess({ visible: !away, effects: fx, readyState: v.readyState, width: v.videoWidth, height: v.videoHeight })) return false;
    if (t - this.lastFrame < MIN_FRAME_MS) return false;
    this.lastFrame = t;

    const c = this.o.canvas;
    if (c.width !== v.videoWidth) c.width = v.videoWidth;
    if (c.height !== v.videoHeight) c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return false;

    const filter = composeFilter(fx, fx.autoAdjust ? this.lumaAt(t) : null);
    try {
      if (filter && 'filter' in ctx) ctx.filter = filter;
      ctx.drawImage(v as unknown as CanvasImageSource, 0, 0, c.width, c.height);
      if (filter && 'filter' in ctx) ctx.filter = 'none';
    } catch { return false; }
    return true;
  }

  private lumaAt(now: number): number | null {
    if (this.lastLumaAt !== 0 && now - this.lastLumaAt < LUMA_INTERVAL_MS) return this.luma;
    this.lastLumaAt = now;
    this.luma = this.measure();
    return this.luma;
  }

  private measure(): number | null {
    try {
      if (typeof document === 'undefined') return null;
      const s = this.sample ?? (this.sample = document.createElement('canvas'));
      s.width = SAMPLE_W; s.height = SAMPLE_H;
      const ctx = s.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(this.o.video as unknown as CanvasImageSource, 0, 0, SAMPLE_W, SAMPLE_H);
      return averageLuma(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
    } catch { return null; }
  }
}
