-- Integration types (0 guild install, 1 user install) and contexts (0 guild, 1 bot DM, 2 private channel) on application commands.
ALTER TABLE application_commands ADD COLUMN IF NOT EXISTS integration_types JSONB NOT NULL DEFAULT '[0]';
ALTER TABLE application_commands ADD COLUMN IF NOT EXISTS contexts JSONB;
-- Per-user installs ("user-installable apps"): the user may run the app's user-install commands anywhere, without the bot being a member.
CREATE TABLE IF NOT EXISTS application_user_installs (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes JSONB NOT NULL DEFAULT '[]',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);
CREATE INDEX IF NOT EXISTS application_user_installs_user_idx ON application_user_installs (user_id);
-- Which integration an interaction was authorized through (0 guild, 1 user) and where it happened (0 guild, 1 bot DM, 2 private channel).
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS integration_type INTEGER;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS context INTEGER;
