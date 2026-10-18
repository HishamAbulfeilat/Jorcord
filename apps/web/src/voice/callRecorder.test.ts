import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRecorder, fmtRecordingDuration, pickRecordingMime, recordingFilename } from './callRecorder';

/* jsdom has no MediaRecorder/WebAudio/MediaStream: the shims fire events and expose the mixed stream by hand. */
class FakeMediaRecorder {
  static all: FakeMediaRecorder[] = [];
  static isTypeSupported() { return true; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  options?: MediaRecorderOptions;
  stream: FakeStream;
  private listeners = new Map<string, Array<(e: { data?: Blob }) => void>>();
  constructor(stream: FakeStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options?.mimeType ?? 'audio/webm;codecs=opus';
    FakeMediaRecorder.all.push(this);
  }
  addEventListener(type: string, cb: (e: { data?: Blob }) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  start() { this.state = 'recording'; }
  emit(size: number) { this.fire('dataavailable', { data: new Blob([new Uint8Array(size)]) }); }
  stop() {
    this.state = 'inactive';
    this.fire('dataavailable', { data: new Blob([new Uint8Array(4)]) });
    this.fire('stop');
  }
  private fire(type: string, ...args: [{ data?: Blob }?]) {
    for (const cb of this.listeners.get(type) ?? []) cb(args[0] ?? {});
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
}

interface FakeTrack { kind: 'audio' | 'video'; id: string; stop: ReturnType<typeof vi.fn> }
const track = (kind: FakeTrack['kind']): FakeTrack => ({ kind, id: `${kind}-${Math.random()}`, stop: vi.fn() });

class FakeSource {
  disconnect = vi.fn();
  constructor(readonly stream: FakeStream) {}
  connect() { return undefined; }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  closed = false;
  sources: FakeSource[] = [];
  constructor() { FakeAudioContext.all.push(this); }
  createMediaStreamDestination() {
    return { stream: new FakeStream([track('audio')]) };
  }
  createMediaStreamSource(stream: FakeStream) {
    const source = new FakeSource(stream);
    this.sources.push(source);
    return source;
  }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}

const pub = (source: string, mediaStreamTrack: FakeTrack): { source: string; track: { mediaStreamTrack: MediaStreamTrack } } =>
  ({ source, track: { mediaStreamTrack: mediaStreamTrack as unknown as MediaStreamTrack } });
const participant = (pubs: Array<{ source: string; track: { mediaStreamTrack: MediaStreamTrack } }>) =>
  ({ trackPublications: new Map(pubs.map((p, i) => [String(i), p])) });
const room = (local: Array<{ source: string; track: { mediaStreamTrack: MediaStreamTrack } }>, remote: Array<{ source: string; track: { mediaStreamTrack: MediaStreamTrack } }> = []) =>
  ({ localParticipant: participant(local), remoteParticipants: new Map(remote.map((p, i) => [String(i), participant([p])])) });

beforeEach(() => {
  FakeMediaRecorder.all = []; FakeAudioContext.all = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 18, 12, 0));
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  (window as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).AudioContext;
});

describe('CallRecorder', () => {
  it('mixes every participant microphone track into one audio stream', async () => {
    const localMic = track('audio'); const remoteMic = track('audio'); const remoteCam = track('video');
    const rec = new CallRecorder();
    await rec.start(room([pub('microphone', localMic)], [pub('microphone', remoteMic), pub('camera', remoteCam)]), { video: false });

    const ctx = FakeAudioContext.all[0]!;
    expect(ctx.sources.map((s) => s.stream.getAudioTracks()[0])).toEqual([localMic, remoteMic]);
    const mr = FakeMediaRecorder.all[0]!;
    expect(mr.options?.mimeType).toBe('audio/webm;codecs=opus');
    expect(mr.stream.getVideoTracks()).toHaveLength(0);
    expect(mr.stream.getAudioTracks()).toHaveLength(1);

    mr.emit(5);
    const file = await rec.stop();
    expect(file!.type).toBe('audio/webm');
    expect(file!.name).toBe('call-recording-2026-10-18-1200.webm');
    // participant tracks stay live for the call; only the synthetic output track is stopped
    expect(localMic.stop).not.toHaveBeenCalled();
    expect(remoteMic.stop).not.toHaveBeenCalled();
    expect(mr.stream.getAudioTracks()[0]!.stop).toHaveBeenCalled();
    expect(ctx.closed).toBe(true);
  });

  it('adds the active screen share and records a video file in video mode', async () => {
    const localMic = track('audio'); const screen = track('video');
    const rec = new CallRecorder();
    await rec.start(room([pub('microphone', localMic)], [pub('screen_share', screen)]), { video: true });

    const mr = FakeMediaRecorder.all[0]!;
    expect(mr.options?.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(mr.stream.getVideoTracks()).toEqual([screen]);
    expect(screen.stop).not.toHaveBeenCalled();

    const file = await rec.stop();
    expect(file!.type).toBe('video/webm');
  });

  it('refuses video mode without an active screen share and tears down cleanly', async () => {
    const rec = new CallRecorder();
    await expect(rec.start(room([pub('microphone', track('audio'))]), { video: true }))
      .rejects.toThrow('There is no active screen share to record.');
    expect(FakeMediaRecorder.all).toHaveLength(0);
    expect(FakeAudioContext.all[0]!.closed).toBe(true);
  });

  it('stops at the 2-hour cap through the limit callback', async () => {
    const onLimit = vi.fn();
    const rec = new CallRecorder({ maxMs: 1000, onLimit });
    await rec.start(room([pub('microphone', track('audio'))]), { video: false });

    await vi.advanceTimersByTimeAsync(999);
    expect(onLimit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onLimit).toHaveBeenCalledWith('time');

    const file = await rec.stop();
    expect(file).toBeTruthy();
  });

  it('stops at the size cap and never returns a file above the upload limit', async () => {
    const onLimit = vi.fn();
    const rec = new CallRecorder({ maxBytes: 10, onLimit });
    await rec.start(room([pub('microphone', track('audio'))]), { video: false });
    const mr = FakeMediaRecorder.all[0]!;

    mr.emit(6);
    expect(onLimit).not.toHaveBeenCalled();
    mr.emit(6); // 12 bytes > 10
    expect(onLimit).toHaveBeenCalledWith('size');

    const file = await rec.stop();
    expect(file!.size).toBe(6); // the chunk that would cross the cap is dropped
  });

  it('formats the timer and chooses a container the browser can encode', () => {
    expect(fmtRecordingDuration(0)).toBe('0:00');
    expect(fmtRecordingDuration(65_000)).toBe('1:05');
    expect(fmtRecordingDuration(3_665_000)).toBe('1:01:05');
    expect(pickRecordingMime(false)).toBe('audio/webm;codecs=opus');
    expect(pickRecordingMime(true)).toBe('video/webm;codecs=vp9,opus');
    expect(recordingFilename(new Date(2026, 9, 18, 9, 5))).toBe('call-recording-2026-10-18-0905.webm');
  });
});
