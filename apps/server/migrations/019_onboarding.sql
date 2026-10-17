-- Server onboarding: questions (channels & roles prompts) answered by new members.
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS default_channel_ids JSONB NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS onboarding_prompts (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  single_select BOOLEAN NOT NULL DEFAULT false,
  required BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  options JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS onboarding_prompts_guild_idx ON onboarding_prompts (guild_id, position);
CREATE TABLE IF NOT EXISTS member_onboarding (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_ids JSONB NOT NULL DEFAULT '[]',
  channel_ids JSONB NOT NULL DEFAULT '[]',
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
