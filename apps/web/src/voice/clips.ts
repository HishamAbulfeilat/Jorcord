/** Module-level clip buffer for this tab: survives the popover closing; at most one buffer at a time. */
import type { StreamSource } from '@jorcord/voice';
import { ClipBuffer, clipRecordingSupported, type ClipWindow, type SavedClip } from './clipBuffer';
import { getVoiceClient } from './controller';
import { useClipUI } from '@/stores/clipui';

let buffer: ClipBuffer | null = null;
let unwatch: (() => void) | null = null;

export const clipsSupported = () => clipRecordingSupported();

export function startClipBuffer(source: StreamSource, windowSec: ClipWindow): void {
  stopClipBuffer();
  const stream = getVoiceClient().getLocalMediaStream(source);
  if (!stream) throw new Error(source === 'screen' ? 'Start a screen share first.' : 'Turn your camera on first.');
  const b = new ClipBuffer(stream, windowSec);
  b.start(); buffer = b;
  // the buffer follows the call: leaving drops it, the source going away keeps the last seconds saveable
  const c = getVoiceClient();
  unwatch = c.subscribe(() => {
    const snap = c.getSnapshot(); const ui = useClipUI.getState();
    if (snap.status === 'idle' || snap.status === 'disconnected') { stopClipBuffer(); return; }
    const on = ui.source === 'screen' ? snap.screenOn : snap.cameraOn;
    if (ui.buffering && !ui.ended && !on) endClipBuffer();
  });
  useClipUI.getState().patch({ buffering: true, source, windowSec });
}

export function stopClipBuffer(): void {
  unwatch?.(); unwatch = null;
  buffer?.dispose(); buffer = null;
  useClipUI.getState().patch({ buffering: false });
}
/** The source went away (share stopped / camera off): keep the last seconds saveable until the buffer is stopped. */
function endClipBuffer(): void { buffer?.end(); useClipUI.getState().patch({ ended: true }); }
export const clipAvailableSec = (): number => buffer?.availableSec() ?? 0;
export const hasClipBuffer = (): boolean => !!buffer;

export async function saveClip(): Promise<SavedClip> {
  if (!buffer) throw new Error('Clip recording is off.');
  const clip = await buffer.save();
  useClipUI.getState().patch({ clip });
  return clip;
}
