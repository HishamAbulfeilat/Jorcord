-- Guild soundboard: short audio clips (uploaded through /uploads) members can play into a voice channel.
CREATE TABLE IF NOT EXISTS soundboard_sounds (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT,
  volume REAL NOT NULL DEFAULT 1,
  url TEXT NOT NULL,
  creator_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS soundboard_guild_idx ON soundboard_sounds (guild_id);
