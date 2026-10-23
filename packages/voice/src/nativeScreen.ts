/**
 * Native (Capacitor) screen sharing. Mobile webviews have no getDisplayMedia, so a native plugin captures the screen
 * (Android MediaProjection, iOS ReplayKit broadcast extension) and sends JPEG frames; this module paints them onto a
 * canvas and exposes `canvas.captureStream()` as an ordinary MediaStreamTrack that the VoiceClient publishes to LiveKit.
 * Everything here is DOM-injectable so it can be unit-tested without a device.
 */

export interface NativeScreenPlugin {
  isSupported(): Promise<{ supported?: boolean }>;
  start(opts?: { maxDimension?: number; fps?: number; quality?: number }): Promise<unknown>;
  stop(): Promise<unknown>;
  addListener(event: 'frame' | 'stopped', cb: (data: any) => void): Promise<{ remove(): unknown }> | { remove(): unknown };
}

export interface NativeScreenSession {
  track: MediaStreamTrack;
  /** Ends capture (idempotent). */
  stop(): Promise<void>;
  /** Called once when capture ends from the native side (system UI, notification, broadcast ended). */
  onEnded(cb: (reason: string) => void): void;
}

export interface NativeScreenSource {
  isSupported(): Promise<boolean>;
  start(opts?: { fps?: number; maxDimension?: number }): Promise<NativeScreenSession>;
}

/** Subset of the DOM the adapter needs; defaults to the real thing. */
export interface NativeScreenEnv {
  createCanvas(): HTMLCanvasElement;
  decode(bytes: Uint8Array): Promise<{ source: CanvasImageSource; width: number; height: number; close?(): void }>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const HEARTBEAT_MS = 1000;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const domEnv = (): NativeScreenEnv => ({
  createCanvas: () => document.createElement('canvas'),
  async decode(bytes) {
    const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('bad frame')); img.src = url; });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
});

/** Map the plugin's rejection codes onto DOMException names that mapVoiceError understands. */
export function nativeScreenError(e: any): Error {
  const code = String(e?.code ?? '');
  const err = new Error(e?.message ?? 'Screen share failed');
  if (code === 'CANCELLED') err.name = 'NotAllowedError';
  else if (code === 'UNSUPPORTED') err.name = 'NotSupportedError';
  else if (code === 'BUSY') err.name = 'AbortError';
  return err;
}

export function createNativeScreenSource(plugin: NativeScreenPlugin | undefined, env: NativeScreenEnv = domEnv()): NativeScreenSource {
  return {
    async isSupported() {
      if (!plugin) return false;
      try { return !!(await plugin.isSupported())?.supported; } catch { return false; }
    },

    async start(opts = {}) {
      if (!plugin) throw nativeScreenError({ code: 'UNSUPPORTED', message: 'Screen sharing is not available on this device.' });
      const canvas = env.createCanvas();
      canvas.width = 2; canvas.height = 2;
      const ctx = canvas.getContext('2d');
      const stream = (canvas as any).captureStream?.(0) as MediaStream | undefined;
      const track = stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
      if (!ctx || !track) throw nativeScreenError({ code: 'UNSUPPORTED', message: 'This webview cannot capture a canvas stream.' });

      let ended = false;
      let last: { source: CanvasImageSource; width: number; height: number } | null = null;
      let busy = false;
      let pending: string | null = null;
      const endedCbs: Array<(reason: string) => void> = [];
      const handles: Array<{ remove(): unknown }> = [];
      let beat: unknown;

      const paint = () => {
        if (!last || ended) return;
        if (canvas.width !== last.width || canvas.height !== last.height) { canvas.width = last.width; canvas.height = last.height; }
        ctx.drawImage(last.source, 0, 0);
        track.requestFrame?.();
      };
      const pump = async () => {
        if (busy) return;
        busy = true;
        try {
          while (pending !== null && !ended) {
            const b64 = pending; pending = null; // only the newest queued frame matters
            try {
              const img = await env.decode(base64ToBytes(b64));
              const old = last; last = img; (old as any)?.close?.();
              paint();
            } catch { /* a corrupt frame is skipped */ }
          }
        } finally { busy = false; }
      };

      const cleanup = async () => {
        if (ended) return false;
        ended = true;
        env.clearInterval(beat);
        for (const h of handles.splice(0)) { try { await h.remove(); } catch { /* */ } }
        try { track.stop(); } catch { /* */ }
        (last as any)?.close?.(); last = null; pending = null;
        return true;
      };

      handles.push(await plugin.addListener('frame', (d: { data?: string }) => { if (d?.data && !ended) { pending = d.data; void pump(); } }));
      handles.push(await plugin.addListener('stopped', async (d: { reason?: string }) => {
        if (await cleanup()) endedCbs.forEach((cb) => cb(String(d?.reason ?? 'stopped')));
      }));

      try { await plugin.start({ fps: opts.fps, maxDimension: opts.maxDimension }); }
      catch (e) { await cleanup(); throw nativeScreenError(e); }

      // A static screen produces no frames; repaint so the encoder keeps emitting (late joiners need a keyframe).
      beat = env.setInterval(paint, HEARTBEAT_MS);

      return {
        track,
        async stop() {
          if (!(await cleanup())) return;
          try { await plugin.stop(); } catch { /* already stopped natively */ }
        },
        onEnded(cb) { endedCbs.push(cb); },
      };
    },
  };
}
