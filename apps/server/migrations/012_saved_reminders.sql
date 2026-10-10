-- "Saved for later" messages and message reminders (both private to the owner).
CREATE TABLE IF NOT EXISTS saved_messages (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS saved_messages_user_idx ON saved_messages (user_id, saved_at DESC);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, guild_id TEXT,
  remind_at TIMESTAMPTZ NOT NULL, fired_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders (user_id, remind_at);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (remind_at) WHERE fired_at IS NULL;
