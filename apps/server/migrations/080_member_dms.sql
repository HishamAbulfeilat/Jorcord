-- Per-server "members may DM each other" policy. NULL = open (the historical behaviour). When set, members who joined after this
-- moment (or everyone, when set to the epoch) can only be reached through that server after they opt in (members.dm_optin).
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS member_dms_restricted_at TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS dm_optin BOOLEAN NOT NULL DEFAULT false;
