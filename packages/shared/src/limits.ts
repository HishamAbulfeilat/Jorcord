/** Jorcord is free: every user gets what Discord reserves for Nitro. */
export const LIMITS = {
  maxUploadBytes: 500 * 1024 * 1024,
  maxMessageLength: 4000,
  maxEmbedsPerMessage: 10,
  maxServersPerUser: 200,
  maxEmojiPerServer: 250,
  maxStickersPerServer: 60,
  maxPins: 50,
  maxStageSeats: 300,
  maxSoundsPerServer: 48,
  maxSoundBytes: 1024 * 1024,
  maxVoiceUsers: 99,
  stream: { maxWidth: 3840, maxHeight: 2160, maxFps: 60, maxBitrateKbps: 40000 },
  audio: { codec: 'opus', bitrateKbps: 510, stereo: true, dtx: true, red: true },
} as const;
