-- AutoMod v3: alert channel, safe-regex rules, more triggers (invite links, caps, repeated characters, tunable spam), multiple actions per rule, test mode.
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS alert_channel_id TEXT;
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS regex_patterns JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';

-- Warnings are written by AutoMod's "warn" action and by moderators (/warn, Mod view).
CREATE TABLE IF NOT EXISTS mod_warnings (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  rule_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mod_warnings_user_idx ON mod_warnings (guild_id, user_id, id);
