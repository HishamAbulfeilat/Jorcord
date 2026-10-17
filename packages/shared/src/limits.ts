/** Jorcord is free: every user gets what Discord reserves for Nitro. */
export const LIMITS = {
  maxUploadBytes: 500 * 1024 * 1024,
  maxMessageLength: 4000,
  maxEmbedsPerMessage: 10,
  maxServersPerUser: 200,
  maxEmojiPerServer: 250,
  maxStickersPerServer: 60,
  maxPins: 50,
  /** Burst (super) reactions a user may send per day (rolling 24h). */
  burstReactionsPerDay: 5,
  /** Colours a burst reaction may use; the first is the default. */
  burstColors: ['#5865F2', '#EB459E', '#FEE75C', '#57F287', '#ED4245'],
  maxStageSeats: 300,
  maxSoundsPerServer: 48,
  maxSoundBytes: 1024 * 1024,
  maxVoiceUsers: 99,
  /** A media channel only accepts posts whose attachments include one of these content-type prefixes (Discord's media-only rule). */
  mediaPostTypes: ['image/', 'video/'],
  stream: { maxWidth: 3840, maxHeight: 2160, maxFps: 60, maxBitrateKbps: 40000 },
  audio: { codec: 'opus', bitrateKbps: 510, stereo: true, dtx: true, red: true },
} as const;
