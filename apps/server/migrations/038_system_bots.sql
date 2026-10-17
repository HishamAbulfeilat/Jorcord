-- Built-in official bots (Welcome, Moderation, Utility) run inside the server process as "system applications".
-- system_key marks them; they have no usable token and no HTTP interactions endpoint.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS system_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS applications_system_key_uq ON applications (system_key) WHERE system_key IS NOT NULL;

-- Per-server configuration of a built-in bot (welcome message, auto-role, ...). A missing row means defaults.
CREATE TABLE IF NOT EXISTS system_bot_settings (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  bot_key TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, bot_key)
);

-- /remind: persisted reminders delivered by DM or in the channel they were set in.
CREATE TABLE IF NOT EXISTS bot_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  via_dm BOOLEAN NOT NULL DEFAULT true,
  content TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_reminders_due_idx ON bot_reminders (remind_at) WHERE fired_at IS NULL;
CREATE INDEX IF NOT EXISTS bot_reminders_user_idx ON bot_reminders (user_id) WHERE fired_at IS NULL;
