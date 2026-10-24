-- Username change (cooldown + 14 day reservation of the old handle) and email change (pending, verified at the new address).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS username_history (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_username TEXT NOT NULL, new_username TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS username_history_user_idx ON username_history (user_id, changed_at);

-- A handle someone just gave up stays theirs for a while so nobody can take it to impersonate them. `username` is stored lower case.
CREATE TABLE IF NOT EXISTS reserved_usernames (
  username TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reserved_until TIMESTAMPTZ NOT NULL
);

-- One pending email change per account; only the sha256 of the emailed token is stored.
CREATE TABLE IF NOT EXISTS email_changes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
