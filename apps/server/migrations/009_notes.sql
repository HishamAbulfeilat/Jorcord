-- Private per-user notes about other users (visible only to the author).
CREATE TABLE IF NOT EXISTS user_notes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id)
);
-- Inbox / mentions lookups.
CREATE INDEX IF NOT EXISTS messages_mentions_idx ON messages USING gin (mentions);
