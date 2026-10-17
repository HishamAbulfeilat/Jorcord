-- Linked roles (roles granted by criteria) and the App Directory (public listing of bots/apps).
CREATE TABLE IF NOT EXISTS linked_roles (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
  description TEXT,
  criteria JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS linked_roles_guild_idx ON linked_roles (guild_id);

-- What an app declares it can tell the server about a member, and the values its bot reported.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS role_metadata JSONB NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS app_user_metadata (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);
CREATE INDEX IF NOT EXISTS app_user_metadata_user_idx ON app_user_metadata (user_id);

-- App Directory listing (owner opt-in; only public bots can be listed).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS directory_listed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS directory_category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS directory_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS directory_tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS directory_permissions TEXT NOT NULL DEFAULT '0';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS directory_listed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS applications_directory_idx ON applications (directory_category) WHERE directory_listed;
