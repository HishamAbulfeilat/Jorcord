-- User-created server templates, public widget, daily join/leave counters for insights.
CREATE TABLE IF NOT EXISTS guild_templates (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL UNIQUE REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  creator_id TEXT NOT NULL,
  serialized JSONB NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS widget_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS widget_channel_id TEXT;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS widget_invite_code TEXT;
CREATE TABLE IF NOT EXISTS guild_daily (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  joins INTEGER NOT NULL DEFAULT 0,
  leaves INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, day)
);
