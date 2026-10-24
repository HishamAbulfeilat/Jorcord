/**
 * Glue between the `cameraBackground` preference and the voice client: attaches the segmentation processor to the published camera
 * when an effect is chosen, switches blur <-> backdrop without reloading the model, and detaches it (releasing the model and the
 * canvas) when set to 'none'. A failure leaves the plain camera running, resets the preference and tells the user once.
 */
import type { VoiceClient } from '@jorcord/voice';
import { toast, useUI } from '@/stores/ui';
import { createBackgroundProcessor } from './backgroundEffect';
import { isCameraBackground, type CameraBackground } from './backgrounds';
import { t } from '@/i18n';

type Processor = ReturnType<typeof createBackgroundProcessor>;
export interface BackgroundDeps {
  create?: typeof createBackgroundProcessor;
  fail?: () => void;
}

let current: CameraBackground = 'none';
let attached: Processor | undefined;
let inFlight: Promise<void> = Promise.resolve();

/** Normalises a stored value (older or hand-edited prefs) to something valid. */
export const normaliseBackground = (v: unknown): CameraBackground => (isCameraBackground(v) ? v : 'none');

/** Apply the preference. Calls are serialised so quick toggling cannot attach two processors. */
export function syncCameraBackground(client: Pick<VoiceClient, 'setCameraProcessor'>, wanted: unknown, deps: BackgroundDeps = {}): Promise<void> {
  const next = normaliseBackground(wanted);
  inFlight = inFlight.then(async () => {
    const was = current; current = next;
    if (next === 'none') {
      if (attached) { attached = undefined; await client.setCameraProcessor(undefined); }
      return;
    }
    if (attached && was !== 'none') return; // blur <-> backdrop: the processor reads `current` for every frame
    const proc = (deps.create ?? createBackgroundProcessor)({ mode: () => current });
    attached = proc;
    const ok = await client.setCameraProcessor(proc);
    if (!ok && attached === proc) {
      attached = undefined; current = 'none';
      (deps.fail ?? defaultFail)();
    }
  }).catch(() => { attached = undefined; });
  return inFlight;
}

function defaultFail() {
  useUI.getState().setPref('cameraBackground', 'none');
  toast(t('Background effects are not available on this device. Your normal camera is still on.'), 'error');
}

/** Test seam. */
export function resetCameraBackground() { current = 'none'; attached = undefined; inFlight = Promise.resolve(); }
