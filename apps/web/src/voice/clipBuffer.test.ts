import { describe, it, expect, vi } from 'vitest';
import { ClipBuffer, lifetimeFor, pickClipMime, shareDurationSeconds, canShareClip, getShareMax, setShareMaxSeconds, SHARE_MAX_SECONDS, type RecorderLike } from './clipBuffer';

class FakeRec implements RecorderLike {
  state = 'inactive'; mimeType = 'video/webm'; ondataavailable: any = null; onerror: any = null; onstop: any = null; stopped = false; id: number;
  static all: FakeRec[] = [];
  constructor() { this.id = FakeRec.all.length; FakeRec.all.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.stopped = true; }
  requestData() { this.ondataavailable?.({ data: new Blob([`chunk-${this.id}`]) }); }
  emit(n = 1) { for (let i = 0; i < n; i++) this.requestData(); }
}
function setup(windowSec: number) {
  vi.useFakeTimers(); vi.setSystemTime(0); FakeRec.all = [];
  const tracks = [{ readyState: 'live', addEventListener: vi.fn(), stop: vi.fn() }]; const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const buf = new ClipBuffer(stream, windowSec, { createRecorder: () => new FakeRec(), isTypeSupported: () => true, now: () => Date.now() });
  return { buf, stream };
}
const sec = (n: number) => vi.advanceTimersByTime(n * 1000);

describe('ClipBuffer', () => {
  it('runs two staggered recorders and always keeps one with a long, complete recording', () => {
    const { buf } = setup(60); buf.start();
    expect(FakeRec.all).toHaveLength(1);
    sec(30); expect(FakeRec.all).toHaveLength(2); // second one half a lifetime later
    sec(30); // the first reached its lifetime: replaced
    expect(FakeRec.all).toHaveLength(3); expect(FakeRec.all[0]!.stopped).toBe(true);
    expect(buf.availableSec()).toBeGreaterThanOrEqual(30); expect(buf.availableSec()).toBeLessThanOrEqual(60);
    for (let i = 0; i < 20; i++) { sec(7); const a = buf.availableSec(); expect(a).toBeGreaterThanOrEqual(30 - 0.01); expect(a).toBeLessThanOrEqual(60); }
    buf.dispose(); vi.useRealTimers();
  });
  it('save() flushes the oldest recorder without stopping the buffer', async () => {
    const { buf } = setup(30); buf.start(); sec(20);
    FakeRec.all[0]!.emit(2);
    const clip = await buf.save();
    expect(clip.durationSec).toBeCloseTo(20, 0); expect(clip.mimeType).toBe('video/webm'); expect(clip.blob.size).toBeGreaterThan(0);
    expect(FakeRec.all[0]!.state).toBe('recording'); // still buffering
    sec(5); expect(FakeRec.all).toHaveLength(2);
    buf.dispose(); vi.useRealTimers();
  });
  it('refuses a clip shorter than 2 s or with no data, and never exceeds the window', async () => {
    const { buf } = setup(30); buf.start(); sec(1);
    await expect(buf.save()).rejects.toThrow(/couple of seconds/);
    sec(10); FakeRec.all[0]!.requestData = () => {}; // recorder that never delivers data
    const p = buf.save(); sec(2); await expect(p).rejects.toThrow(/No video data/);
    buf.dispose(); vi.useRealTimers();
  });
  it('the server cap is 120 s: all three recorder windows can be shared, the 2 minute one records 1 s less', () => {
    expect(SHARE_MAX_SECONDS).toBe(120); expect(getShareMax()).toBe(120);
    expect(lifetimeFor(30)).toBe(30); expect(lifetimeFor(60)).toBe(60); expect(lifetimeFor(120)).toBeLessThan(120);
    expect(shareDurationSeconds(29.2)).toBe(30); expect(shareDurationSeconds(45)).toBe(45); expect(shareDurationSeconds(0.2)).toBe(1); expect(shareDurationSeconds(500)).toBe(120);
    expect(canShareClip(29.5)).toBe(true); expect(canShareClip(60)).toBe(true); expect(canShareClip(119.9)).toBe(true); expect(canShareClip(121)).toBe(false);
  });
  it('follows a lower or higher cap from the server and ignores nonsense', () => {
    try {
      setShareMaxSeconds(30);
      expect(getShareMax()).toBe(30); expect(lifetimeFor(30)).toBe(29); expect(lifetimeFor(60)).toBe(60);
      expect(canShareClip(45)).toBe(false); expect(shareDurationSeconds(45)).toBe(30);
      setShareMaxSeconds('x'); setShareMaxSeconds(NaN); setShareMaxSeconds(1); setShareMaxSeconds(undefined);
      expect(getShareMax()).toBe(30);
      setShareMaxSeconds(300.7); expect(getShareMax()).toBe(300); expect(lifetimeFor(120)).toBe(120);
    } finally { setShareMaxSeconds(SHARE_MAX_SECONDS); }
  });
  it('after the source ends the last seconds stay saveable but nothing new starts', async () => {
    const { buf } = setup(30); buf.start(); sec(12); FakeRec.all[0]!.emit();
    buf.end(); sec(60);
    expect(FakeRec.all).toHaveLength(1); expect(buf.isEnded).toBe(true); // the second recorder (due at 14.5 s) never started
    const clip = await buf.save(); expect(clip.durationSec).toBeCloseTo(12, 0);
    buf.dispose(); vi.useRealTimers();
  });
  it('restarts a recorder that errors, and dispose() frees everything', () => {
    const { buf, stream } = setup(60); buf.start(); sec(1);
    FakeRec.all[0]!.onerror?.({}); expect(FakeRec.all).toHaveLength(2);
    buf.dispose(); expect(FakeRec.all.every((r) => r.state === 'inactive')).toBe(true);
    expect((stream.getTracks()[0] as any).stop).toHaveBeenCalled(); sec(300); expect(FakeRec.all).toHaveLength(2);
    vi.useRealTimers();
  });
  it('picks a supported mime, or reports that recording is unsupported', () => {
    expect(pickClipMime((m) => m === 'video/webm')).toBe('video/webm'); expect(pickClipMime(() => false)).toBeNull();
    expect(() => new ClipBuffer({ getTracks: () => [] } as unknown as MediaStream, 30, { isTypeSupported: () => false })).toThrow(/cannot record clips/);
  });
});
