-- Voice moderation (persisted across reconnects), webhook per-message overrides, account deletion, auth tokens, thread membership.
ALTER TABLE members ADD COLUMN IF NOT EXISTS voice_mute BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE members ADD COLUMN IF NOT EXISTS voice_deaf BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_username TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE dm_participants ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One-time tokens (email verification, password reset). Only the sha256 of the token is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS thread_members_user_idx ON thread_members (user_id);
CREATE INDEX IF NOT EXISTS channels_thread_list_idx ON channels (parent_id, archived) WHERE type = 'thread';
