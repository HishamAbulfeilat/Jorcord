-- Boost levels page: booster role, announcement switch, and managed roles (granted by the server, not by hand).
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS booster_role_id TEXT;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS boost_announce BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS booster_role_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS managed_kind TEXT; -- 'booster' | 'linked': members cannot be given or stripped of these by hand
CREATE INDEX IF NOT EXISTS boosts_user_idx ON boosts (guild_id, user_id);
