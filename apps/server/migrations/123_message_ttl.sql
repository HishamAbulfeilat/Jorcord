-- Disappearing messages for DMs / group DMs: the channel timer and the per-message deadline the sweeper acts on.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS message_ttl_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
