-- Platform pass: applications/bots/OAuth2, application commands + interactions, message components, polls, scheduled events, stage instances, forum tags + thread lifecycle.

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT,
  bot_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bot_token_hash TEXT NOT NULL,            -- sha256 of the bot token secret part; the token itself is shown once
  client_secret_hash TEXT NOT NULL,        -- sha256; shown once
  public_key TEXT NOT NULL,                -- hex Ed25519 public key (apps verify interaction deliveries with it)
  private_key_enc TEXT NOT NULL,           -- Ed25519 private key (PKCS8 DER base64url), AES-GCM encrypted with the server secret
  interactions_endpoint_url TEXT, redirect_uris JSONB NOT NULL DEFAULT '[]', bot_public BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS applications_owner_idx ON applications (owner_id);

CREATE TABLE IF NOT EXISTS application_installs (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  scopes JSONB NOT NULL DEFAULT '[]', installed_by TEXT NOT NULL, role_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, guild_id)
);
CREATE INDEX IF NOT EXISTS application_installs_guild_idx ON application_installs (guild_id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS managed_app_id TEXT;

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scopes JSONB NOT NULL, redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scopes JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx ON oauth_tokens (user_id);

CREATE TABLE IF NOT EXISTS application_commands (
  id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE, scope_key TEXT NOT NULL,   -- guild id or '' for global
  type INTEGER NOT NULL CHECK (type IN (1,2,3)), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  options JSONB NOT NULL DEFAULT '[]', default_member_permissions TEXT, dm_permission BOOLEAN NOT NULL DEFAULT true, nsfw BOOLEAN NOT NULL DEFAULT false,
  version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS application_commands_name_uq ON application_commands (application_id, scope_key, type, name);
CREATE INDEX IF NOT EXISTS application_commands_guild_idx ON application_commands (guild_id) WHERE guild_id IS NOT NULL;

-- target_id = command id (per-command overwrites) or application id (app-wide default overwrites)
CREATE TABLE IF NOT EXISTS command_permissions (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL, target_id TEXT NOT NULL, target_type INTEGER NOT NULL CHECK (target_type IN (1,2,3)), permission BOOLEAN NOT NULL,
  PRIMARY KEY (application_id, guild_id, command_id, target_id, target_type)
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type INTEGER NOT NULL, token_hash TEXT NOT NULL, user_id TEXT NOT NULL, guild_id TEXT, channel_id TEXT,
  message_id TEXT, data JSONB, acked BOOLEAN NOT NULL DEFAULT false, ephemeral BOOLEAN NOT NULL DEFAULT false,
  response_message_id TEXT, modal JSONB, deferred_update BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS interactions_expiry_idx ON interactions (expires_at);

-- Ephemeral (only-you) interaction responses are never stored in `messages`, so no list/search/pins/export path can leak them.
CREATE TABLE IF NOT EXISTS ephemeral_messages (
  id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel_id TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ephemeral_messages_interaction_idx ON ephemeral_messages (interaction_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS application_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS interaction JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll_expiry TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll_finalized BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS messages_poll_expiry_idx ON messages (poll_expiry) WHERE poll IS NOT NULL AND NOT poll_finalized;

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, answer_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, answer_id)
);
CREATE INDEX IF NOT EXISTS poll_votes_answer_idx ON poll_votes (message_id, answer_id, user_id);

CREATE TABLE IF NOT EXISTS guild_scheduled_events (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, channel_id TEXT,
  creator_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, scheduled_start TIMESTAMPTZ NOT NULL, scheduled_end TIMESTAMPTZ,
  status INTEGER NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 4), entity_type INTEGER NOT NULL CHECK (entity_type BETWEEN 1 AND 3),
  location TEXT, image TEXT, stage_instance_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gse_guild_idx ON guild_scheduled_events (guild_id, scheduled_start);
CREATE INDEX IF NOT EXISTS gse_due_idx ON guild_scheduled_events (status, scheduled_start) WHERE status IN (1,2);
CREATE TABLE IF NOT EXISTS guild_scheduled_event_users (
  event_id TEXT NOT NULL REFERENCES guild_scheduled_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS stage_instances (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  topic TEXT NOT NULL, scheduled_event_id TEXT, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS available_tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS require_tag BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_auto_archive INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS applied_tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS auto_archive_minutes INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS activity_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS channels_autoarchive_idx ON channels (activity_at) WHERE type = 'thread' AND NOT archived;

-- New permission bits (SEND_POLLS = 1<<41, USE_EXTERNAL_APPS = 1<<42) granted to existing @everyone roles (role id = guild id).
UPDATE roles SET permissions = ((permissions::bigint) | 6597069766656::bigint)::text WHERE id = guild_id;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS action_type INTEGER;
CREATE INDEX IF NOT EXISTS audit_guild_action_idx ON audit_log (guild_id, action_type, id);
