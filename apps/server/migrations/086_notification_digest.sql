-- Notification digest ("quiet mode"): servers/channels flagged `digest` batch their pings into periodic Inbox entries.
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS notification_digest_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('hourly','daily')),
  -- joining a server with more members than the threshold sets that server to mentions-only (never overrides an existing choice)
  large_server_mentions_only BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Held-back notifications waiting for the next digest. Ids only: no message text is copied here.
CREATE TABLE IF NOT EXISTS digest_pending (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  -- true: @mentioned by name or a DM; false: a role / @everyone ping
  mention BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS digest_pending_user_idx ON digest_pending (user_id, created_at);
-- a message is held at most once per user (both the badge path and the push path may try)
CREATE UNIQUE INDEX IF NOT EXISTS digest_pending_msg_uq ON digest_pending (user_id, message_id);

CREATE TABLE IF NOT EXISTS digest_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  total INTEGER NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS digest_entries_user_idx ON digest_entries (user_id, id DESC);
