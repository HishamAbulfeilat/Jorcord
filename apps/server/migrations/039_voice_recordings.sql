-- Voice-channel recording sessions: a durable record of who started a recording and when, so the
-- recording indicator is server-owned (and survives reconnects/multi-node deployments).
CREATE TABLE IF NOT EXISTS voice_recordings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  started_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  stopped_at TIMESTAMPTZ
);

-- A channel can have at most one active recording; stopped sessions remain as history.
CREATE UNIQUE INDEX IF NOT EXISTS voice_recordings_active_uq ON voice_recordings (channel_id) WHERE stopped_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_recordings_channel_idx ON voice_recordings (channel_id, started_at DESC);
