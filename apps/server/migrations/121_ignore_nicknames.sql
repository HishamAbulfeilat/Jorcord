-- Ignore user (distinct from block: the messages are still delivered, clients hide them) and private friend nicknames.
CREATE TABLE IF NOT EXISTS ignored_users (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, other_id), CHECK (user_id <> other_id)
);
CREATE INDEX IF NOT EXISTS ignored_users_other_idx ON ignored_users (other_id);
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS nickname TEXT;
