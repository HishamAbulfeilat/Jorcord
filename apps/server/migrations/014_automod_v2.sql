-- AutoMod depth: keyword presets, allow-list, configurable mention limit and timeout length, exempt channels, custom block message.
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS presets JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS allow_list JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS mention_limit INTEGER NOT NULL DEFAULT 5;
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS exempt_channels JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS custom_message TEXT;
