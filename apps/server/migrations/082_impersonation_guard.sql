-- Impersonation guard: new members whose name closely matches the owner, staff or the server name are flagged (or held) for moderators.
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS impersonation_guard JSONB NOT NULL DEFAULT '{}';
ALTER TABLE members ADD COLUMN IF NOT EXISTS impersonation_flag JSONB;
ALTER TABLE members ADD COLUMN IF NOT EXISTS safety_hold BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS members_impersonation_idx ON members (guild_id) WHERE impersonation_flag IS NOT NULL;
