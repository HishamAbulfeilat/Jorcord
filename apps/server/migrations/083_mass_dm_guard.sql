-- Mass-DM spam detection: recent first messages to people who have not accepted the sender yet, the resulting limits and an operator log.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dm_limited_until TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS dm_request_events (
  id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, has_link BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dm_request_events_sender ON dm_request_events (sender_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mass_dm_incidents (
  id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL, recipients INTEGER NOT NULL,
  sample TEXT NOT NULL DEFAULT '', limited_until TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mass_dm_incidents_created ON mass_dm_incidents (created_at DESC);
