-- Privacy settings (who may DM / friend-request me) and message requests.
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy JSONB NOT NULL DEFAULT '{}';
-- A 1:1 DM opened by a non-friend lands in the recipient's "Message Requests" until they accept or reply.
ALTER TABLE dm_participants ADD COLUMN IF NOT EXISTS request BOOLEAN NOT NULL DEFAULT false;
-- Ignored message requests: the ignored person cannot open a new DM to the ignorer.
CREATE TABLE IF NOT EXISTS dm_ignores (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, other_id)
);
