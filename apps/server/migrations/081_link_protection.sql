-- Scam/phishing link protection: per-server allow and deny lists of hostnames (the scoring itself is local code, no external calls).
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS link_allow JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS link_deny JSONB NOT NULL DEFAULT '[]';
