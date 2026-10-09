/**
 * RNNoise-style noise suppression as a LiveKit TrackProcessor, via @shiguredo/noise-suppression (optional dep, mono only).
 * Falls back (returns undefined) when Insertable Streams are unsupported.
 */
import type { TrackProcessor, Track } from 'livekit-client';

export async function createRnnoiseProcessor(): Promise<TrackProcessor<Track.Kind.Audio> | undefined> {
  let mod: any;
  try { mod = await import('@shiguredo/noise-suppression'); } catch { return undefined; }
  const NS = mod.NoiseSuppressionProcessor ?? mod.default?.NoiseSuppressionProcessor;
  if (!NS || !NS.isSupported?.()) return undefined;
  const inner = new NS();
  const proc: TrackProcessor<Track.Kind.Audio> = {
    name: 'jv-rnnoise',
    processedTrack: undefined,
    async init(opts: any) { proc.processedTrack = await inner.startProcessing(opts.track); },
    async restart(opts: any) { inner.stopProcessing(); proc.processedTrack = await inner.startProcessing(opts.track); },
    async destroy() { inner.stopProcessing(); proc.processedTrack = undefined; },
  };
  return proc;
}
