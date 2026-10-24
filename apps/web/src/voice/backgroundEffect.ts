/**
 * Camera background blur / replacement on the PUBLISHED camera track (everyone in the call sees it, not just your preview).
 *
 * A LiveKit TrackProcessor reads the camera, segments the person (MediaPipe selfie model, see ./segmentation) and paints
 * person-over-backdrop into a canvas whose captureStream() becomes the track that is sent. CPU/battery care:
 *  - the model is loaded only when an effect is switched on, and released when it is switched off or the camera stops;
 *  - inference runs on every 2nd frame (every 3rd/4th when it is slow) and the last mask is reused in between;
 *  - output is capped at 1280 px wide; blurring uses a tiny down/up-scaled copy instead of a per-pixel filter;
 *  - nothing is processed while the tab is hidden: the last picture is held (never the raw room, which could leak the background).
 * If the model cannot load, `init` rejects, the voice client keeps the plain camera and the UI is told why.
 */
import type { CameraProcessor } from '@jorcord/voice';
import { PolarityVote, loadMediaPipeSegmenter, type PersonMask, type PersonSegmenter, type SegmenterLoader } from './segmentation';
import { paintPreset, isCameraBackground, type BackgroundPresetId, type CameraBackground } from './backgrounds';

export const MAX_OUT_WIDTH = 1280;
export const TARGET_FPS = 24;
const BLUR_DIVISOR = 16;
const SLOW_MS = 45, FAST_MS = 18;

interface Ctx2D {
  drawImage(...a: any[]): void; clearRect(x: number, y: number, w: number, h: number): void; fillRect(x: number, y: number, w: number, h: number): void;
  createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(d: any, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(o: number, c: string): void };
  globalCompositeOperation: string; fillStyle: unknown; imageSmoothingEnabled: boolean; imageSmoothingQuality?: string; filter?: string;
}
export interface CanvasLike { width: number; height: number; getContext(id: '2d', o?: unknown): Ctx2D | null }
export interface VideoLike { videoWidth: number; videoHeight: number; readyState: number }

export interface CompositorOptions {
  segmenter: PersonSegmenter;
  video: VideoLike;
  out: CanvasLike;
  makeCanvas: (w: number, h: number) => CanvasLike;
  mode: () => CameraBackground;
  now?: () => number;
  hidden?: () => boolean;
}

/** Output size for a camera frame: same aspect, at most MAX_OUT_WIDTH wide, even numbers. */
export function outputSize(vw: number, vh: number): { w: number; h: number } {
  if (!vw || !vh) return { w: 0, h: 0 };
  const s = Math.min(1, MAX_OUT_WIDTH / vw);
  return { w: Math.max(2, Math.round((vw * s) / 2) * 2), h: Math.max(2, Math.round((vh * s) / 2) * 2) };
}

export class BackgroundCompositor {
  private frames = 0;
  private segEvery = 2;
  private inferMs = 0;
  private lastTs = 0;
  private mask: PersonMask | null = null;
  private readonly vote = new PolarityVote();
  private maskCanvas?: CanvasLike; private person?: CanvasLike; private small?: CanvasLike;
  private maskImage?: { data: Uint8ClampedArray };
  /** Number of inference calls made (exposed for tests and the cadence logic). */
  inferences = 0;

  constructor(private readonly o: CompositorOptions) {}

  get cadence() { return this.segEvery; }

  /** One pass: segment if due, then paint. Returns false when nothing was painted (tab hidden, no frame yet). */
  frame(): boolean {
    const o = this.o; const v = o.video;
    if ((o.hidden ? o.hidden() : typeof document !== 'undefined' && document.hidden) || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return false;
    const { w, h } = outputSize(v.videoWidth, v.videoHeight);
    const out = o.out;
    if (out.width !== w) out.width = w;
    if (out.height !== h) out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return false;
    const now = o.now ? o.now() : performance.now();
    if (this.frames++ % this.segEvery === 0) this.segmentFrame(now);
    this.paint(ctx, w, h);
    return true;
  }

  close() { this.o.segmenter.close(); }

  private segmentFrame(now: number) {
    const ts = Math.max(this.lastTs + 1, now); this.lastTs = ts;
    let m: PersonMask | null = null;
    try { m = this.o.segmenter.segment(this.o.video as unknown as CanvasImageSource, ts); } catch { m = null; }
    this.inferences++;
    const spent = (this.o.now ? this.o.now() : performance.now()) - now;
    this.inferMs = this.inferMs ? this.inferMs * 0.8 + spent * 0.2 : spent;
    if (this.inferMs > SLOW_MS && this.segEvery < 4) this.segEvery++;
    else if (this.inferMs < FAST_MS && this.segEvery > 2) this.segEvery--;
    if (!m) return;
    if (!this.vote.decided) this.vote.add(m);
    this.mask = m; this.writeMask(m);
  }

  private writeMask(m: PersonMask) {
    const o = this.o;
    const mc = this.maskCanvas ?? (this.maskCanvas = o.makeCanvas(m.width, m.height));
    if (mc.width !== m.width) mc.width = m.width;
    if (mc.height !== m.height) mc.height = m.height;
    const mctx = mc.getContext('2d'); if (!mctx) return;
    if (!this.maskImage || this.maskImage.data.length !== m.width * m.height * 4) this.maskImage = mctx.createImageData(m.width, m.height);
    const px = this.maskImage.data; const flip = this.vote.invert;
    for (let i = 0, n = m.width * m.height; i < n; i++) px[i * 4 + 3] = (m.data[i]! !== 0) !== flip ? 255 : 0;
    mctx.putImageData(this.maskImage, 0, 0);
  }

  private paint(ctx: Ctx2D, w: number, h: number) {
    const o = this.o; const mode = o.mode();
    ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'medium';
    // backdrop
    if (mode === 'blur' || !isCameraBackground(mode) || mode === 'none') {
      const sw = Math.max(2, Math.round(w / BLUR_DIVISOR)), sh = Math.max(2, Math.round(h / BLUR_DIVISOR));
      const s = this.small ?? (this.small = o.makeCanvas(sw, sh));
      if (s.width !== sw) s.width = sw;
      if (s.height !== sh) s.height = sh;
      const sctx = s.getContext('2d');
      if (sctx) { sctx.drawImage(o.video, 0, 0, sw, sh); ctx.drawImage(s, 0, 0, w, h); }
    } else paintPreset(ctx, mode as BackgroundPresetId, w, h);
    // the person on top; until the first mask exists only the backdrop is shown, never the raw room
    if (!this.mask || !this.maskCanvas) return;
    const p = this.person ?? (this.person = o.makeCanvas(w, h));
    if (p.width !== w) p.width = w;
    if (p.height !== h) p.height = h;
    const pctx = p.getContext('2d'); if (!pctx) return;
    pctx.globalCompositeOperation = 'source-over';
    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(o.video, 0, 0, w, h);
    pctx.globalCompositeOperation = 'destination-in';
    if ('filter' in pctx) pctx.filter = 'blur(2px)'; // soft edge; harmlessly ignored where unsupported
    pctx.drawImage(this.maskCanvas, 0, 0, w, h);
    if ('filter' in pctx) pctx.filter = 'none';
    pctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(p, 0, 0, w, h);
  }
}

export interface BackgroundProcessorOptions {
  mode: () => CameraBackground;
  loader?: SegmenterLoader;
  fps?: number;
}
type VideoProcessorOpts = { track: MediaStreamTrack };

/** A LiveKit video TrackProcessor producing the composited camera. */
export function createBackgroundProcessor(opts: BackgroundProcessorOptions): CameraProcessor {
  const loader = opts.loader ?? loadMediaPipeSegmenter;
  const fps = opts.fps ?? TARGET_FPS;
  let video: HTMLVideoElement | undefined; let canvas: HTMLCanvasElement | undefined; let comp: BackgroundCompositor | undefined;
  let stop = false; let timer: ReturnType<typeof setTimeout> | undefined; let rvfc: number | undefined;
  const proc: CameraProcessor = {
    name: 'jorcord-camera-background',
    processedTrack: undefined,
    async init(o) { await start(o as unknown as VideoProcessorOpts); },
    async restart(o) { await teardown(true); await start(o as unknown as VideoProcessorOpts); },
    async destroy() { await teardown(true); },
  };
  const schedule = () => {
    if (stop || !video) return;
    const step = () => { if (stop) return; try { comp?.frame(); } catch { /* keep going */ } schedule(); };
    if ('requestVideoFrameCallback' in video && !document.hidden) rvfc = (video as any).requestVideoFrameCallback(() => { rvfc = undefined; step(); });
    else timer = setTimeout(step, document.hidden ? 1000 : Math.round(1000 / fps));
  };
  async function start(o: VideoProcessorOpts) {
    stop = false;
    const segmenter = await loader();
    try {
      video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.autoplay = true;
      video.srcObject = new MediaStream([o.track]);
      await video.play().catch(() => { /* autoplay can be refused until a gesture; frames still arrive once it plays */ });
      canvas = document.createElement('canvas');
      comp = new BackgroundCompositor({ segmenter, video, out: canvas as unknown as CanvasLike, makeCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c as unknown as CanvasLike; }, mode: opts.mode });
      const s = o.track.getSettings();
      if (s.width && s.height) { const sz = outputSize(s.width, s.height); canvas.width = sz.w; canvas.height = sz.h; }
      proc.processedTrack = canvas.captureStream(fps).getVideoTracks()[0];
      schedule();
    } catch (e) { segmenter?.close(); throw e; }
  }
  async function teardown(final: boolean) { // `final` kept for clarity: both paths release everything
    stop = true;
    if (timer) clearTimeout(timer); if (rvfc != null && video && 'cancelVideoFrameCallback' in video) (video as any).cancelVideoFrameCallback(rvfc);
    timer = undefined; rvfc = undefined;
    if (video) { video.pause(); video.srcObject = null; video = undefined; }
    if (final) { comp?.close(); comp = undefined; proc.processedTrack?.stop(); proc.processedTrack = undefined; canvas = undefined; }
  }
  return proc;
}
