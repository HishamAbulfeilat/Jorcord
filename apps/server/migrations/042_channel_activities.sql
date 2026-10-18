-- Shared voice-channel activities (Watch Together and games). One live session per channel and kind.
CREATE TABLE IF NOT EXISTS channel_activities (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_activities_live_uq ON channel_activities (channel_id, kind);
CREATE INDEX IF NOT EXISTS channel_activities_channel_idx ON channel_activities (channel_id, id);
