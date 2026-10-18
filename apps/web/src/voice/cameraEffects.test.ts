import { describe, expect, it } from 'vitest';
import { defaultPrefs, useUI } from '@/stores/ui';
import { SelfViewPainter, averageLuma, autoAdjustFilter, composeFilter, effectsEnabled, isCanvasFilterSupported, shouldProcess } from './cameraEffects';

describe('camera effect preferences', () => {
  it('ships the canvas effects off by default, with self-view mirroring kept on', () => {
    expect(defaultPrefs.cameraBlur).toBe(false);
    expect(defaultPrefs.cameraAutoAdjust).toBe(false);
    expect(defaultPrefs.mirrorSelfView).toBe(true);
  });

  it('persists the toggles with the other ui preferences', () => {
    const prev = useUI.getState().prefs;
    useUI.getState().setPref('cameraAutoAdjust', true);
    expect(useUI.getState().prefs.cameraAutoAdjust).toBe(true);
    expect(JSON.parse(localStorage.getItem('jorcord.prefs.v1') ?? '{}').cameraAutoAdjust).toBe(true);
    useUI.getState().setPref('cameraAutoAdjust', prev.cameraAutoAdjust);
  });
});

describe('camera effect filters', () => {
  it('detects canvas 2D filter support', () => {
    expect(isCanvasFilterSupported({ filter: '' })).toBe(true);
    expect(isCanvasFilterSupported({})).toBe(false);
    expect(isCanvasFilterSupported(null)).toBe(false);
  });

  it('lifts dark frames, tames bright ones and leaves the midtones alone', () => {
    expect(autoAdjustFilter(null)).toBe('');
    expect(autoAdjustFilter(Number.NaN)).toBe('');
    expect(autoAdjustFilter(128)).toBe('');
    expect(autoAdjustFilter(0)).toBe('brightness(1.35) contrast(1.05)');
    const dark = autoAdjustFilter(40);
    expect(dark).toContain('brightness(1.2');
    const bright = autoAdjustFilter(240);
    expect(bright).toContain('brightness(0.8');
    // out-of-range samples are clamped, not folded back
    expect(autoAdjustFilter(1000)).toBe(autoAdjustFilter(255));
  });

  it('composes blur before the exposure nudge and stays empty when everything is off', () => {
    expect(composeFilter({ blur: false, autoAdjust: false })).toBe('');
    expect(composeFilter({ blur: true, autoAdjust: false })).toBe('blur(6px)');
    expect(composeFilter({ blur: false, autoAdjust: true }, 20)).toMatch(/^brightness\(/);
    expect(composeFilter({ blur: true, autoAdjust: true }, 20)).toMatch(/^blur\(6px\) brightness\(/);
    expect(composeFilter({ blur: true, autoAdjust: true }, 128)).toBe('blur(6px)');
  });

  it('only processes visible, ready frames with at least one effect enabled', () => {
    expect(effectsEnabled({ blur: false, autoAdjust: false })).toBe(false);
    expect(effectsEnabled({ blur: true, autoAdjust: false })).toBe(true);
    expect(shouldProcess({ visible: false, effects: { blur: true, autoAdjust: false }, readyState: 4, width: 640, height: 360 })).toBe(false);
    expect(shouldProcess({ visible: true, effects: { blur: false, autoAdjust: false }, readyState: 4, width: 640, height: 360 })).toBe(false);
    expect(shouldProcess({ visible: true, effects: { blur: true, autoAdjust: false }, readyState: 1, width: 640, height: 360 })).toBe(false);
    expect(shouldProcess({ visible: true, effects: { blur: true, autoAdjust: false }, readyState: 4, width: 0, height: 360 })).toBe(false);
    expect(shouldProcess({ visible: true, effects: { blur: true, autoAdjust: false }, readyState: 4, width: 640, height: 360 })).toBe(true);
  });

  it('averages luminance from sampled RGBA pixels', () => {
    expect(averageLuma([])).toBeNull();
    expect(averageLuma(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))).toBeCloseTo(127.5, 1);
    expect(averageLuma(new Uint8ClampedArray([0, 255, 0, 255]))).toBeCloseTo(182.4, 0);
  });
});

const video = { videoWidth: 640, videoHeight: 360, readyState: 4 };

function fakeCanvas() {
  const ctx: any = { filter: 'none', painted: null as string | null, drawImage: () => { ctx.painted = ctx.filter; } };
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, ctx };
}

describe('SelfViewPainter', () => {
  it('paints one throttled frame with the blur filter', () => {
    const { canvas, ctx } = fakeCanvas();
    const painter = new SelfViewPainter({ video, canvas, effects: () => ({ blur: true, autoAdjust: false }) });

    expect(painter.frame(1000, false)).toBe(true);
    expect(ctx.painted).toBe('blur(6px)');
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);

    // ~12 fps cap: a second call within the same frame window is a no-op
    expect(painter.frame(1010, false)).toBe(false);
    expect(painter.frame(1100, false)).toBe(true);
  });

  it('does no work while hidden or while the effects are off', () => {
    const { canvas, ctx } = fakeCanvas();
    const on = new SelfViewPainter({ video, canvas, effects: () => ({ blur: true, autoAdjust: false }) });
    expect(on.frame(5000, true)).toBe(false);
    expect(ctx.painted).toBeNull();

    const off = new SelfViewPainter({ video, canvas, effects: () => ({ blur: false, autoAdjust: false }) });
    expect(off.frame(5000, false)).toBe(false);
  });

  it('skips frames before the camera delivers video', () => {
    const { canvas } = fakeCanvas();
    const painter = new SelfViewPainter({ video: { videoWidth: 0, videoHeight: 0, readyState: 0 }, canvas, effects: () => ({ blur: true, autoAdjust: false }) });
    expect(painter.frame(1000, false)).toBe(false);
  });
});
