-- Application (bot-owned) emoji: usable by the application's bot in any message it sends.
CREATE TABLE IF NOT EXISTS application_emojis (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  animated BOOLEAN NOT NULL DEFAULT false,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_emojis_app_idx ON application_emojis (application_id, id);
