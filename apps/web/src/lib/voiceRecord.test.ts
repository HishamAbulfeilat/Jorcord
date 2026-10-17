import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder } from './voiceRecord';

/* Fakes: jsdom has no MediaRecorder/BlobEvent/WebAudio, so the class shim fires the events by hand. */
class FakeRecorder {
  static all: FakeRecorder[] = [];
  static isTypeSupported(m: string) { return m === 'audio/webm;codecs=opus'; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  options?: MediaRecorderOptions;
  private listeners = new Map<string, Array<(e: { data?: Blob }) => void>>();
  constructor(_stream: unknown, options?: MediaRecorderOptions) {
    this.options = options;
    FakeRecorder.all.push(this);
  }
  addEventListener(type: string, cb: (e: { data?: Blob }) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  start() { this.state = 'recording'; this.fire('dataavailable', { data: new Blob(['chunk'], { type: 'audio/webm' }) }); }
  stop() {
    this.state = 'inactive';
    this.fire('dataavailable', { data: new Blob(['tail'], { type: 'audio/webm' }) });
    this.fire('stop');
  }
  private fire(type: string, ...args: [{ data?: Blob }?]) {
    for (const cb of this.listeners.get(type) ?? []) cb(args[0] ?? {});
  }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  closed = false;
  constructor() { FakeAudioContext.all.push(this); }
  createMediaStreamSource() { return { connect: vi.fn() }; }
  createAnalyser() { return { fftSize: 512, getByteTimeDomainData: (buf: Uint8Array) => buf.fill(140) }; }
  close() { this.closed = true; return Promise.resolve(); }
}

const fakeStream = () => {
  const track = { stop: vi.fn() };
  return { track, getTracks: () => [track] };
};

const gmu = vi.fn();
let lastStream: { track: { stop: ReturnType<typeof vi.fn> }; getTracks: () => unknown[] };
beforeEach(() => {
  lastStream = fakeStream();
  gmu.mockReset().mockResolvedValue(lastStream);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  (window as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia: gmu }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).AudioContext;
});

describe('VoiceRecorder', () => {
  it('records, samples peaks, and returns a bare-webm File named like Discord does', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 17, 9, 5));
    const got: number[][] = [];
    const rec = new VoiceRecorder((peaks) => got.push([...peaks]));
    await rec.start();

    expect(FakeRecorder.all[0]!.options!.mimeType).toBe('audio/webm;codecs=opus'); // best encoding requested
    await vi.advanceTimersByTimeAsync(350); // 100/200/300: three 100ms samples
    expect(got).toHaveLength(3);
    expect(got.every((p) => p.every((v) => v > 0))).toBe(true); // analyser fed 140 -> peak 12/128

    const take = await rec.stop();
    expect(take).toBeTruthy();
    expect(take!.file.type).toBe('audio/webm'); // codecs stripped: the server serves it inline
    expect(take!.file.name).toBe('voice-message-2026-10-17-0905.webm');
    expect(take!.peaks).toHaveLength(3);
    expect(take!.durationSec).toBeGreaterThanOrEqual(0);
    expect(await rec.stop()).toBeNull(); // already torn down
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toHaveLength(3); // interval is gone
    expect(gmu).toHaveBeenCalledTimes(1);
  });

  it('stops the mic tracks and closes the AudioContext on teardown', async () => {
    vi.useFakeTimers();
    const rec = new VoiceRecorder();
    await rec.start();
    await rec.stop();
    expect(lastStream.track.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.all[0]!.closed).toBe(true);
    rec.cancel(); // safe to call on an already-dead recorder
  });

  it('cancel() discards without ever producing a file', async () => {
    vi.useFakeTimers();
    const rec = new VoiceRecorder();
    await rec.start();
    expect(rec.active).toBe(true);
    rec.cancel();
    expect(rec.active).toBe(false);
  });

  it('stop() without start is a no-op returning null and never touches the mic', async () => {
    const rec = new VoiceRecorder();
    expect(await rec.stop()).toBeNull();
    expect(gmu).not.toHaveBeenCalled();
  });
});
