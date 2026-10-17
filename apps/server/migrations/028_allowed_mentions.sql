ALTER TABLE messages ADD COLUMN IF NOT EXISTS allowed_mentions JSONB;
