-- Moderation suite (package F): audit diffs, role memory, removal notices, anonymous report queue, ban-evasion hints, mod wellbeing.
-- Safe on a populated database: only nullable / constant-default ADD COLUMNs (metadata-only on Postgres 11+) and new tables.

-- Per-server moderation settings (remember roles, removal notices, evasion hints, retention, blur default). Normalised in code (packages/shared moderation.ts).
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS mod_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Audit log: {before, after} of exactly the fields an action changed. `changes` keeps its old meaning.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS diff JSONB;

-- The invite code a member arrived with (copied to bans when they are banned): input for the ban-evasion "same invite" signal.
ALTER TABLE members ADD COLUMN IF NOT EXISTS joined_via TEXT;
ALTER TABLE bans ADD COLUMN IF NOT EXISTS joined_via TEXT;

-- Reports: reporter anonymity towards moderators, a snapshot taken at report time (the message may be edited or deleted later),
-- duplicate reports of the same message fold into the first open one (canonical_id), and the canned action a moderator took.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS snapshot JSONB;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS canonical_id TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS action_taken TEXT;

-- Roles a member had when they were kicked / left / were timed out, kept for N days so a rejoin can restore them.
CREATE TABLE IF NOT EXISTS member_role_memory (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles JSONB NOT NULL DEFAULT '[]'::jsonb,        -- [{id, permissions}] permissions as held when remembered: a role that grew since is never restored
  nick TEXT,
  timeout_until TIMESTAMPTZ,                       -- a leave/rejoin must not shake off a timeout
  granted_by TEXT,                                 -- the moderator who removed them (their reach limits what is restored); null = left on their own
  reason TEXT NOT NULL CHECK (reason IN ('kick','leave','timeout')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS member_role_memory_expiry ON member_role_memory (expires_at);

-- Notice shown to a member who was kicked / banned / timed out (reason + appeal link). The moderator is stored only when the server shows names.
CREATE TABLE IF NOT EXISTS mod_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  guild_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kick','ban','timeout')),
  reason TEXT,
  moderator_id TEXT,
  appeal BOOLEAN NOT NULL DEFAULT false,
  until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mod_notices_user ON mod_notices (user_id, id DESC);

-- A moderator's own wellbeing settings for one server.
CREATE TABLE IF NOT EXISTS mod_prefs (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blur_media BOOLEAN,                              -- null = follow the server default
  quiet_start SMALLINT,                            -- minutes after local midnight, null = no quiet hours
  quiet_end SMALLINT,
  tz_offset SMALLINT NOT NULL DEFAULT 0,           -- minutes east of UTC, sent by the client
  PRIMARY KEY (guild_id, user_id)
);

-- Ban-evasion hints: a new member resembles a recently banned one. Name / avatar / timing / invite only. No IP, no fingerprint.
CREATE TABLE IF NOT EXISTS evasion_hints (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_user_id TEXT NOT NULL,
  score SMALLINT NOT NULL,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','confirmed')),
  handled_by TEXT, handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id, banned_user_id)
);
CREATE INDEX IF NOT EXISTS evasion_hints_queue ON evasion_hints (guild_id, status, id DESC);
