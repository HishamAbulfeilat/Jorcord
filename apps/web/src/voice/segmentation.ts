/**
 * Person segmentation for camera background blur / replacement.
 *
 * MediaPipe's Selfie Segmenter (Apache-2.0) runs in WASM on this page. Everything is self-hosted: the runtime comes from the
 * `@mediapipe/tasks-vision` package and the 250 KB model sits in `./models`, both emitted by Vite on our own origin (CSP: script-src 'self'
 * 'wasm-unsafe-eval'). The whole thing is imported dynamically, so nobody downloads ~10 MB of WASM until they turn an effect on.
 *
 * The segmenter is behind the tiny `PersonSegmenter` interface so the compositor and its tests never need the real model.
 */

/** A per-pixel foreground mask: 1 where there is a person, 0 for background. */
export interface PersonMask { data: Uint8Array; width: number; height: number }

export interface PersonSegmenter {
  /** Segment one video frame. Returns null while the model has nothing for this frame. `ts` must increase between calls. */
  segment(video: CanvasImageSource, ts: number): PersonMask | null;
  close(): void;
}
export type SegmenterLoader = () => Promise<PersonSegmenter>;

/**
 * The selfie model labels background 0 and person 1, but a wrong guess would cut the person out instead of the room. So the mask
 * is checked against a prior every camera has: the person is near the middle of the frame and the frame edges are room. Returns true
 * when the mask looks inverted (edges mostly "person", centre mostly "background").
 */
export function looksInverted(m: PersonMask): boolean {
  const { data, width: w, height: h } = m;
  if (!w || !h || data.length < w * h) return false;
  let edge = 0, edgeN = 0, mid = 0, midN = 0;
  const bx = Math.max(1, Math.floor(w * 0.1)), by = Math.max(1, Math.floor(h * 0.1));
  const cx0 = Math.floor(w * 0.35), cx1 = Math.ceil(w * 0.65), cy0 = Math.floor(h * 0.4), cy1 = Math.ceil(h * 0.9);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const v = data[y * w + x]! ? 1 : 0;
      if (x < bx || x >= w - bx || y < by) { edge += v; edgeN++; }
      else if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) { mid += v; midN++; }
    }
  }
  if (!edgeN || !midN) return false;
  return edge / edgeN > 0.6 && mid / midN < 0.4;
}

/** Majority vote over the first frames, so one odd frame cannot flip the polarity. */
export class PolarityVote {
  private inverted = 0; private total = 0;
  constructor(private readonly frames = 12) {}
  get decided() { return this.total >= this.frames; }
  get invert() { return this.inverted * 2 > this.total; }
  add(m: PersonMask) { if (this.decided) return; this.total++; if (looksInverted(m)) this.inverted++; }
}

/** MediaPipe + the self-hosted model. Throws when the browser lacks WebAssembly or anything fails to load. */
export const loadMediaPipeSegmenter: SegmenterLoader = async () => {
  if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available');
  const [mp, wasmLoaderPath, wasmBinaryPath, modelAssetPath] = await Promise.all([
    import('@mediapipe/tasks-vision'),
    import('@mediapipe/tasks-vision/vision_wasm_internal.js?url').then((m) => m.default as string),
    import('@mediapipe/tasks-vision/vision_wasm_internal.wasm?url').then((m) => m.default as string),
    import('./models/selfie_segmenter.tflite?url').then((m) => m.default as string),
  ]);
  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const make = (delegate: 'GPU' | 'CPU') => mp.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', outputCategoryMask: true, outputConfidenceMasks: false,
  });
  let seg: Awaited<ReturnType<typeof make>>;
  try { seg = await make('GPU'); } catch { seg = await make('CPU'); }
  return {
    segment(video, ts) {
      const res = seg.segmentForVideo(video as never, ts);
      try {
        const m = res.categoryMask;
        if (!m) return null;
        // copy: the mask's buffer belongs to the runtime and is invalid after close()
        return { data: m.getAsUint8Array().slice(), width: m.width, height: m.height };
      } finally { res.close(); }
    },
    close() { try { seg.close(); } catch { /* already closed */ } },
  };
};
