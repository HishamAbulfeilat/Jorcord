-- Safety Setup: verification level, explicit-media filter, default notifications, raid protection.
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS verification_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS explicit_filter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS default_notifications TEXT NOT NULL DEFAULT 'mentions';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS raid_protection JSONB NOT NULL DEFAULT '{}';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS invites_paused_until TIMESTAMPTZ;
