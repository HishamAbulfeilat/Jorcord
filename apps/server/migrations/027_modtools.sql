-- Moderation tools: mod notes, raid-join flag on members.
CREATE TABLE IF NOT EXISTS mod_notes (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mod_notes_user_idx ON mod_notes (guild_id, user_id, id);
ALTER TABLE members ADD COLUMN IF NOT EXISTS raid_flagged BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_log (guild_id, target_id);
