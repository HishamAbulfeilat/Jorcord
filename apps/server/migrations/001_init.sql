-- Jorcord initial schema. IDs are snowflake strings (TEXT). Permission bitfields are decimal TEXT.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT, username TEXT NOT NULL, display_name TEXT,
  password_hash TEXT,
  avatar TEXT, banner TEXT, accent_color TEXT, bio TEXT, pronouns TEXT,
  bot BOOLEAN NOT NULL DEFAULT false,
  custom_status JSONB, theme TEXT NOT NULL DEFAULT 'dark', settings JSONB NOT NULL DEFAULT '{}',
  presence TEXT NOT NULL DEFAULT 'online',
  mfa_secret TEXT, mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (lower(username)) WHERE bot = false;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL, user_agent TEXT, ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS relationships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('friend','blocked','incoming','outgoing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, other_id), CHECK (user_id <> other_id)
);

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, banner TEXT, description TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  system_channel_id TEXT, rules_channel_id TEXT, vanity_url TEXT,
  features JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS guilds_vanity_uq ON guilds (lower(vanity_url)) WHERE vanity_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color INTEGER NOT NULL DEFAULT 0, hoist BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0, permissions TEXT NOT NULL DEFAULT '0',
  mentionable BOOLEAN NOT NULL DEFAULT false, icon TEXT
);
CREATE INDEX IF NOT EXISTS roles_guild_idx ON roles (guild_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  type TEXT NOT NULL, name TEXT, topic TEXT, position INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT, nsfw BOOLEAN NOT NULL DEFAULT false, slowmode INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER, user_limit INTEGER, last_message_id TEXT, owner_id TEXT,
  archived BOOLEAN NOT NULL DEFAULT false, dm_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channels_guild_idx ON channels (guild_id);
CREATE INDEX IF NOT EXISTS channels_parent_idx ON channels (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_key_uq ON channels (dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS dm_participants (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_participants_user_idx ON dm_participants (user_id);

CREATE TABLE IF NOT EXISTS overwrites (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('role','member')),
  allow TEXT NOT NULL DEFAULT '0', deny TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, target_id)
);

CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick TEXT, avatar TEXT, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), timeout_until TIMESTAMPTZ,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user_idx ON members (user_id);

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS member_roles_role_idx ON member_roles (role_id);

CREATE TABLE IF NOT EXISTS bans (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT, banned_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, inviter_id TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER, expires_at TIMESTAMPTZ, temporary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_guild_idx ON invites (guild_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, changes JSONB, reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_guild_idx ON audit_log (guild_id, id);

CREATE TABLE IF NOT EXISTS emojis (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, animated BOOLEAN NOT NULL DEFAULT false, url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, url TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'png'
);
CREATE TABLE IF NOT EXISTS boosts (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS automod_rules (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, trigger TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]', action TEXT NOT NULL, exempt_roles JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL, avatar TEXT, token TEXT NOT NULL, bot_user_id TEXT NOT NULL, creator_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL, content_type TEXT NOT NULL, size BIGINT NOT NULL,
  width INTEGER, height INTEGER, spoiler BOOLEAN NOT NULL DEFAULT false,
  attached BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id TEXT, author_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', edited_at TIMESTAMPTZ, type TEXT NOT NULL DEFAULT 'default',
  reply_to TEXT, mention_everyone BOOLEAN NOT NULL DEFAULT false,
  mentions JSONB NOT NULL DEFAULT '[]', mention_roles JSONB NOT NULL DEFAULT '[]',
  attachments JSONB NOT NULL DEFAULT '[]', embeds JSONB NOT NULL DEFAULT '[]',
  sticker_ids JSONB NOT NULL DEFAULT '[]', pinned BOOLEAN NOT NULL DEFAULT false,
  thread_id TEXT, webhook_id TEXT,
  has_link BOOLEAN NOT NULL DEFAULT false, has_image BOOLEAN NOT NULL DEFAULT false, has_file BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages (channel_id, id);
CREATE INDEX IF NOT EXISTS messages_guild_idx ON messages (guild_id, id);
CREATE INDEX IF NOT EXISTS messages_author_idx ON messages (author_id, channel_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL, emoji_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS read_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id TEXT, mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
