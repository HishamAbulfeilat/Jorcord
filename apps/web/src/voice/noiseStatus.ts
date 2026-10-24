import type { NoiseFallbackReason } from '@jorcord/voice';

export type NoiseMode = 'off' | 'browser' | 'rnnoise' | 'high';

const FALLBACK: Record<NoiseFallbackReason, string> = {
  unsupported: 'This browser cannot run RNNoise (no AudioWorklet/WebAssembly)',
  'no-worklet-url': 'The RNNoise module is not available in this build',
  'load-failed': 'The RNNoise module could not be loaded',
  'start-failed': 'RNNoise could not be attached to your microphone',
  underrun: 'RNNoise could not keep up on this device (it would have sounded robotic or cut out)',
  'worklet-error': 'RNNoise stopped working',
};

/** One line under the selector. `fallback` is set once a call showed RNNoise could not start. */
export function noiseStatusText(mode: NoiseMode, o: { musicMode: boolean; fallback: NoiseFallbackReason | null }): { text: string; tone: 'info' | 'warn' } {
  if (o.fallback && (mode === 'rnnoise' || mode === 'high')) return { text: `${FALLBACK[o.fallback]}. Using the browser's built-in suppression instead.`, tone: 'warn' };
  if (o.musicMode && (mode === 'rnnoise' || mode === 'high')) return { text: 'Music mode is on: RNNoise is skipped so music is not filtered.', tone: 'info' };
  switch (mode) {
    case 'off': return { text: 'No noise suppression is applied.', tone: 'info' };
    case 'browser': return { text: 'Uses your browser or system noise suppression.', tone: 'info' };
    case 'rnnoise': return { text: 'RNNoise runs on-device, no audio leaves your computer for processing.', tone: 'info' };
    case 'high': return { text: 'RNNoise plus the browser filter. Strongest, uses more CPU.', tone: 'info' };
  }
}
