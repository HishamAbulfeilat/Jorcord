-- Announcement channel follows + crossposted messages.
CREATE TABLE IF NOT EXISTS channel_follows (
  id TEXT PRIMARY KEY,
  source_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_guild_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, target_channel_id)
);
CREATE INDEX IF NOT EXISTS channel_follows_target_idx ON channel_follows (target_channel_id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS crosspost JSONB;
