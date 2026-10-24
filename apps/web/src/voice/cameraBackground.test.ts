import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundCompositor, outputSize, MAX_OUT_WIDTH, type CanvasLike } from './backgroundEffect';
import { PolarityVote, looksInverted, type PersonMask, type PersonSegmenter } from './segmentation';
import { normaliseBackground, resetCameraBackground, syncCameraBackground } from './cameraBackground';
import { CAMERA_BACKGROUNDS, isCameraBackground } from './backgrounds';

/** A W x H mask with a filled box (the "person") in the middle-bottom. */
function personMask(w = 32, h = 32, invert = false): PersonMask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= w * 0.3 && x < w * 0.7 && y >= h * 0.35;
    data[y * w + x] = inside !== invert ? 1 : 0;
  }
  return { data, width: w, height: h };
}

describe('mask polarity safety net', () => {
  it('accepts a centred person and flags an inverted mask', () => {
    expect(looksInverted(personMask())).toBe(false);
    expect(looksInverted(personMask(32, 32, true))).toBe(true);
    expect(looksInverted({ data: new Uint8Array(0), width: 0, height: 0 })).toBe(false);
  });
  it('decides by majority over the first frames', () => {
    const v = new PolarityVote(5);
    for (const inv of [false, true, true, true, false]) v.add(personMask(32, 32, inv));
    expect(v.decided).toBe(true); expect(v.invert).toBe(true);
    v.add(personMask()); // ignored once decided
    expect(v.invert).toBe(true);
  });
});

/** Canvas fake that records the draw calls. */
function fakeCanvas(log: string[], name: string): CanvasLike & { ctx: any } {
  const alpha: { data: Uint8ClampedArray } = { data: new Uint8ClampedArray(0) };
  const ctx: any = {
    globalCompositeOperation: 'source-over', fillStyle: '', imageSmoothingEnabled: true,
    drawImage: (src: any, ..._r: any[]) => log.push(`${name}.draw(${src?.__name ?? 'video'})@${ctx.globalCompositeOperation}`),
    clearRect: () => log.push(`${name}.clear`), fillRect: () => log.push(`${name}.fill`),
    createImageData: (w: number, h: number) => { alpha.data = new Uint8ClampedArray(w * h * 4); return alpha; },
    putImageData: () => log.push(`${name}.putMask`),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return { width: 0, height: 0, getContext: () => ctx, ctx, __name: name, alpha } as never;
}

function setup(opts: { hidden?: boolean; mode?: any; mask?: () => PersonMask | null; now?: () => number } = {}) {
  const log: string[] = [];
  const canvases: Record<string, any> = {};
  const makeCanvas = (w: number) => { const name = w === 1280 ? 'person' : w === 80 ? 'small' : 'mask'; return (canvases[name] = fakeCanvas(log, name)); };
  const segment = vi.fn((_v: unknown, _ts: number) => (opts.mask ? opts.mask() : personMask()));
  const seg: PersonSegmenter = { segment, close: vi.fn() };
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4 };
  let mode = opts.mode ?? 'blur'; let hidden = !!opts.hidden;
  const out = fakeCanvas(log, 'out');
  const comp = new BackgroundCompositor({ segmenter: seg, video, out, makeCanvas, mode: () => mode, hidden: () => hidden, now: opts.now });
  return { comp, seg, segment, log, canvases, out, setMode: (m: string) => { mode = m; }, setHidden: (h: boolean) => { hidden = h; } };
}

describe('BackgroundCompositor', () => {
  it('caps the output size and keeps the aspect ratio', () => {
    expect(outputSize(1920, 1080)).toEqual({ w: MAX_OUT_WIDTH, h: 720 });
    expect(outputSize(640, 480)).toEqual({ w: 640, h: 480 });
    expect(outputSize(0, 0)).toEqual({ w: 0, h: 0 });
  });

  it('never paints the raw room before the first mask exists, then composites the person over the backdrop', () => {
    const s = setup({ mask: () => null });
    expect(s.comp.frame()).toBe(true);
    expect(s.log.filter((l) => l.startsWith('out.draw'))).toEqual(['out.draw(small)@source-over']); // blurred backdrop only: no person layer
    expect(s.canvases.person).toBeUndefined();

    const t = setup();
    t.comp.frame();
    const j = t.log.join('\n');
    expect(j).toContain('person.draw(video)@source-over'); // the person layer takes the camera frame...
    expect(j).toContain('person.draw(mask)@destination-in'); // ...and keeps only what the mask covers
    expect(t.log.filter((l) => l.startsWith('out.draw'))).toEqual(['out.draw(small)@source-over', 'out.draw(person)@source-over']);
    expect(t.out.width).toBe(MAX_OUT_WIDTH);
  });

  it('paints a preset backdrop instead of the blurred room', () => {
    const s = setup({ mode: 'dusk' });
    s.comp.frame();
    expect(s.log).toContain('out.fill');
    expect(s.log.filter((l) => l.startsWith('small'))).toEqual([]);
  });

  it('writes person pixels as opaque alpha and background as transparent, flipping an inverted model', () => {
    const s = setup({ mask: () => personMask(32, 32) });
    s.comp.frame();
    const a = s.canvases.mask.alpha.data as Uint8ClampedArray;
    expect(a[3]).toBe(0); // top-left corner: background
    expect(a[(24 * 32 + 16) * 4 + 3]).toBe(255); // lower middle: person
    const inv = setup({ mask: () => personMask(32, 32, true) });
    for (let i = 0; i < 30; i++) inv.comp.frame();
    const b = inv.canvases.mask.alpha.data as Uint8ClampedArray;
    expect(b[3]).toBe(0); expect(b[(24 * 32 + 16) * 4 + 3]).toBe(255); // corrected to the same result
  });

  it('does no work while the tab is hidden, and no inference on in-between frames', () => {
    const s = setup({ hidden: true });
    expect(s.comp.frame()).toBe(false); expect(s.segment).not.toHaveBeenCalled(); expect(s.log).toEqual([]);
    s.setHidden(false);
    for (let i = 0; i < 6; i++) s.comp.frame();
    expect(s.segment).toHaveBeenCalledTimes(3); // every 2nd frame
  });

  it('backs off the inference rate when the model is slow', () => {
    let t = 0;
    const s = setup({ now: () => (t += 100) }); // every call "takes" 100 ms
    for (let i = 0; i < 40; i++) s.comp.frame();
    expect(s.comp.cadence).toBe(4);
  });

  it('survives a segmenter that throws', () => {
    const s = setup({ mask: () => { throw new Error('gpu lost'); } });
    expect(() => s.comp.frame()).not.toThrow();
  });
});

describe('syncCameraBackground', () => {
  beforeEach(() => resetCameraBackground());
  const fakeClient = (ok = true) => ({ setCameraProcessor: vi.fn(async () => ok) });
  const fakeProc = () => ({ name: 'x', init: async () => {}, restart: async () => {}, destroy: async () => {} });

  it('validates stored values', () => {
    expect(normaliseBackground('blur')).toBe('blur'); expect(normaliseBackground('bogus')).toBe('none'); expect(normaliseBackground(undefined)).toBe('none');
    expect(CAMERA_BACKGROUNDS.every(isCameraBackground)).toBe(true);
  });

  it('attaches once, keeps the processor when only switching effect, and detaches on none', async () => {
    const c = fakeClient(); const create = vi.fn(fakeProc);
    await syncCameraBackground(c, 'blur', { create });
    await syncCameraBackground(c, 'dusk', { create });
    expect(create).toHaveBeenCalledTimes(1); expect(c.setCameraProcessor).toHaveBeenCalledTimes(1);
    await syncCameraBackground(c, 'none', { create });
    expect(c.setCameraProcessor).toHaveBeenLastCalledWith(undefined);
    await syncCameraBackground(c, 'none', { create });
    expect(c.setCameraProcessor).toHaveBeenCalledTimes(2); // nothing attached: nothing to do
  });

  it('falls back to the plain camera and reports when the processor cannot start', async () => {
    const c = fakeClient(false); const fail = vi.fn();
    await syncCameraBackground(c, 'blur', { create: fakeProc, fail });
    expect(fail).toHaveBeenCalledTimes(1);
    const c2 = fakeClient(); await syncCameraBackground(c2, 'blur', { create: fakeProc, fail }); // a later attempt starts afresh
    expect(c2.setCameraProcessor).toHaveBeenCalledTimes(1);
  });

  it('serialises rapid toggling', async () => {
    const order: string[] = [];
    const c = { setCameraProcessor: vi.fn(async (p: unknown) => { order.push(p ? 'on' : 'off'); await new Promise((r) => setTimeout(r, 5)); return true; }) };
    await Promise.all([syncCameraBackground(c, 'blur', { create: fakeProc }), syncCameraBackground(c, 'none', { create: fakeProc }), syncCameraBackground(c, 'aurora', { create: fakeProc })]);
    expect(order).toEqual(['on', 'off', 'on']);
  });
});
