import { LIMITS } from '@jorcord/shared';

export type NoiseMode = 'off' | 'browser' | 'rnnoise' | 'high';
export const NOISE_MODES: NoiseMode[] = ['off', 'browser', 'rnnoise', 'high'];

export interface AudioSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /**
   * 'off' = none, 'browser' = built-in NS constraint, 'rnnoise' = Standard (RNNoise WASM AudioWorklet, mono only),
   * 'high' = RNNoise plus the browser's own suppression on the capture. Overrides noiseSuppression.
   */
  noiseSuppressionMode: NoiseMode;
  /** Music mode: stereo, no processing, high bitrate. */
  musicMode: boolean;
  bitrateKbps: number;
  dtx: boolean;
  red: boolean;
  inputDeviceId?: string;
  outputDeviceId?: string;
}

export const DEFAULT_AUDIO: AudioSettings = {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  noiseSuppressionMode: 'browser', musicMode: false,
  bitrateKbps: 64, dtx: true, red: true,
};

export const MIN_AUDIO_KBPS = 8;
export const MAX_AUDIO_KBPS = LIMITS.audio.bitrateKbps; // 510

export function clampAudioBitrate(kbps: number, stereo: boolean): number {
  const lo = stereo ? 32 : MIN_AUDIO_KBPS;
  return Math.max(lo, Math.min(MAX_AUDIO_KBPS, Math.round(kbps)));
}

export interface ResolvedAudio {
  capture: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean; channelCount: number; sampleRate: number; deviceId?: string };
  publish: { audioBitrate: number; dtx: boolean; red: boolean; forceStereo: boolean };
  useRnnoise: boolean;
}

/** Pure: map user-facing settings -> getUserMedia constraints + Opus publish options. */
export function resolveAudio(s: AudioSettings): ResolvedAudio {
  const stereo = s.musicMode;
  const ns = (s.noiseSuppressionMode === 'browser' || s.noiseSuppressionMode === 'high') && s.noiseSuppression;
  return {
    capture: {
      echoCancellation: stereo ? false : s.echoCancellation,
      noiseSuppression: stereo ? false : ns,
      autoGainControl: stereo ? false : s.autoGainControl,
      channelCount: stereo ? 2 : 1,
      sampleRate: 48000,
      ...(s.inputDeviceId ? { deviceId: s.inputDeviceId } : {}),
    },
    publish: {
      audioBitrate: clampAudioBitrate(stereo ? Math.max(s.bitrateKbps, 128) : s.bitrateKbps, stereo) * 1000,
      // DTX hurts music (clips quiet passages); keep user's choice for voice
      dtx: stereo ? false : s.dtx,
      // RED is mono-only in libwebrtc/LiveKit defaults
      red: stereo ? false : s.red,
      forceStereo: stereo,
    },
    useRnnoise: !stereo && s.noiseSuppression && (s.noiseSuppressionMode === 'rnnoise' || s.noiseSuppressionMode === 'high'),
  };
}
