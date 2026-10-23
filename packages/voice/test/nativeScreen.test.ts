import { describe, expect, it, vi } from 'vitest';
import { base64ToBytes, createNativeScreenSource, nativeScreenError, type NativeScreenEnv, type NativeScreenPlugin } from '../src/nativeScreen';
import { detectPlatform } from '../src/mobile';

function fakePlugin(over: Partial<NativeScreenPlugin> = {}) {
  const handlers: Record<string, (d: any) => any> = {};
  const removed: string[] = [];
  const plugin: NativeScreenPlugin = {
    isSupported: vi.fn().mockResolvedValue({ supported: true }),
    start: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue({}),
    addListener: vi.fn(async (ev: string, cb: (d: any) => void) => { handlers[ev] = cb; return { remove: () => { removed.push(ev); } }; }) as any,
    ...over,
  };
  return { plugin, handlers, removed };
}

function fakeEnv() {
  const draws: Array<{ w: number; h: number }> = [];
  const requestFrame = vi.fn();
  const trackStop = vi.fn();
  const track: any = { requestFrame, stop: trackStop, kind: 'video' };
  const canvas: any = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => draws.push({ w: canvas.width, h: canvas.height }) }),
    captureStream: vi.fn(() => ({ getVideoTracks: () => [track] })),
  };
  let beat: (() => void) | undefined;
  const env: NativeScreenEnv = {
    createCanvas: () => canvas,
    decode: vi.fn(async (bytes: Uint8Array) => ({ source: {} as any, width: bytes[0] * 10, height: bytes[0] * 20 })),
    setInterval: (fn) => { beat = fn; return 1; },
    clearInterval: vi.fn(),
  };
  return { env, canvas, track, draws, requestFrame, trackStop, beat: () => beat?.() };
}
const b64 = (n: number) => btoa(String.fromCharCode(n, 1, 2));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('native screen source', () => {
  it('reports unsupported without a plugin or when the plugin says no / throws', async () => {
    expect(await createNativeScreenSource(undefined).isSupported()).toBe(false);
    expect(await createNativeScreenSource(fakePlugin({ isSupported: vi.fn().mockResolvedValue({ supported: false }) }).plugin).isSupported()).toBe(false);
    expect(await createNativeScreenSource(fakePlugin({ isSupported: vi.fn().mockRejectedValue(new Error('x')) }).plugin).isSupported()).toBe(false);
    expect(await createNativeScreenSource(fakePlugin().plugin).isSupported()).toBe(true);
  });

  it('decodes base64 frames onto the canvas and requests a track frame each time', async () => {
    const { plugin, handlers } = fakePlugin(); const e = fakeEnv();
    const session = await createNativeScreenSource(plugin, e.env).start({ fps: 8, maxDimension: 1280 });
    expect(plugin.start).toHaveBeenCalledWith({ fps: 8, maxDimension: 1280 });
    expect(session.track).toBe(e.track);
    handlers.frame({ data: b64(3) }); await flush();
    expect(e.draws).toEqual([{ w: 30, h: 60 }]);
    expect(e.requestFrame).toHaveBeenCalledTimes(1);
    handlers.frame({ data: b64(5) }); await flush();
    expect(e.draws.at(-1)).toEqual({ w: 50, h: 100 }); // canvas follows the frame size
  });

  it('keeps only the newest queued frame while decoding is busy', async () => {
    const { plugin, handlers } = fakePlugin(); const e = fakeEnv();
    await createNativeScreenSource(plugin, e.env).start();
    handlers.frame({ data: b64(1) }); handlers.frame({ data: b64(2) }); handlers.frame({ data: b64(3) });
    await flush();
    expect((e.env.decode as any).mock.calls.length).toBe(2); // first + newest, the middle one was superseded
    expect(e.draws.at(-1)).toEqual({ w: 30, h: 60 });
  });

  it('repaints the last frame on the heartbeat so a static screen keeps the stream alive', async () => {
    const { plugin, handlers } = fakePlugin(); const e = fakeEnv();
    await createNativeScreenSource(plugin, e.env).start();
    e.beat(); expect(e.requestFrame).not.toHaveBeenCalled(); // nothing to repaint yet
    handlers.frame({ data: b64(2) }); await flush();
    e.beat(); expect(e.requestFrame).toHaveBeenCalledTimes(2);
  });

  it('ignores corrupt frames', async () => {
    const { plugin, handlers } = fakePlugin(); const e = fakeEnv();
    (e.env.decode as any).mockRejectedValueOnce(new Error('bad'));
    await createNativeScreenSource(plugin, e.env).start();
    handlers.frame({ data: b64(1) }); await flush();
    handlers.frame({ data: b64(2) }); await flush();
    expect(e.draws).toEqual([{ w: 20, h: 40 }]);
  });

  it('stop() ends the track, removes listeners, tells the plugin once', async () => {
    const { plugin, removed } = fakePlugin(); const e = fakeEnv();
    const session = await createNativeScreenSource(plugin, e.env).start();
    await session.stop(); await session.stop();
    expect(e.trackStop).toHaveBeenCalledTimes(1);
    expect(plugin.stop).toHaveBeenCalledTimes(1);
    expect([...removed].sort()).toEqual(['frame', 'stopped']);
  });

  it('a native "stopped" event fires onEnded and cleans up without calling plugin.stop', async () => {
    const { plugin, handlers } = fakePlugin(); const e = fakeEnv();
    const session = await createNativeScreenSource(plugin, e.env).start();
    const ended = vi.fn(); session.onEnded(ended);
    await handlers.stopped({ reason: 'system' });
    expect(ended).toHaveBeenCalledWith('system');
    expect(e.trackStop).toHaveBeenCalled();
    expect(plugin.stop).not.toHaveBeenCalled();
    handlers.frame({ data: b64(1) }); await flush();
    expect(e.draws).toEqual([]); // late frames after the end are dropped
  });

  it('maps a declined consent dialog to NotAllowedError and cleans up', async () => {
    const { plugin, removed } = fakePlugin({ start: vi.fn().mockRejectedValue({ code: 'CANCELLED', message: 'no' }) }); const e = fakeEnv();
    await expect(createNativeScreenSource(plugin, e.env).start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(e.trackStop).toHaveBeenCalled();
    expect(removed.length).toBe(2);
  });

  it('fails cleanly when the webview cannot capture a canvas', async () => {
    const { plugin } = fakePlugin(); const e = fakeEnv();
    e.canvas.captureStream = undefined;
    await expect(createNativeScreenSource(plugin, e.env).start()).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it('error and base64 helpers', () => {
    expect(nativeScreenError({ code: 'BUSY' }).name).toBe('AbortError');
    expect(nativeScreenError({ code: 'FAILED', message: 'm' }).message).toBe('m');
    expect(Array.from(base64ToBytes(btoa('AB')))).toEqual([65, 66]);
  });

  it('a Capacitor webview stays unsupported until a native source opts in', () => {
    const p = detectPlatform('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', { mediaDevices: {} }, true);
    expect(p.canScreenShare).toBe(false);
    expect(p.nativeScreenShare).toBeUndefined();
  });
});
