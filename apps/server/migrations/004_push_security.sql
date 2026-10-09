-- Push notifications: one row per registered device (web push subscription, FCM or APNs token).
-- `token` is the push endpoint for web/desktop subscriptions, else the FCM/APNs device token. It is globally unique so
-- a device that changes hands is re-assigned to whoever registers it last.
CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('web','android','ios','desktop')),
  token TEXT NOT NULL UNIQUE, keys JSONB, session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON push_devices (user_id);
CREATE INDEX IF NOT EXISTS push_devices_session_idx ON push_devices (session_id) WHERE session_id IS NOT NULL;

-- Per-user notification preferences. scope 'guild' (muted / mutedUntil / suppress flags / level) or 'channel' (muted / mutedUntil).
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('guild','channel')), target_id TEXT NOT NULL,
  muted BOOLEAN NOT NULL DEFAULT false, muted_until TIMESTAMPTZ,
  suppress_everyone BOOLEAN NOT NULL DEFAULT false, suppress_roles BOOLEAN NOT NULL DEFAULT false,
  level TEXT CHECK (level IN ('all','mentions','none')),
  PRIMARY KEY (user_id, scope, target_id)
);
-- "who wants every message of this guild" lookup
CREATE INDEX IF NOT EXISTS notification_settings_target_idx ON notification_settings (scope, target_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT true;

-- TOTP replay protection: the highest 30s step already accepted for the user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;

-- Index review: reverse relationship lookups (blocks, friend fan-out), per-user upload accounting, webhook lookups, session cleanup.
CREATE INDEX IF NOT EXISTS relationships_other_idx ON relationships (other_id, type);
CREATE INDEX IF NOT EXISTS files_uploader_idx ON files (uploader_id) WHERE NOT attached;
CREATE INDEX IF NOT EXISTS webhooks_channel_idx ON webhooks (channel_id);
CREATE INDEX IF NOT EXISTS reactions_user_idx ON reactions (user_id);
CREATE INDEX IF NOT EXISTS boosts_guild_idx ON boosts (guild_id);
CREATE INDEX IF NOT EXISTS emojis_guild_idx ON emojis (guild_id);
CREATE INDEX IF NOT EXISTS stickers_guild_idx ON stickers (guild_id);
CREATE INDEX IF NOT EXISTS automod_rules_guild_idx ON automod_rules (guild_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS messages_pinned_idx ON messages (channel_id, id) WHERE pinned;
