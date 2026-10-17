-- Forwarded messages carry a snapshot of the original (content, attachments, embeds, origin ids).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forward JSONB;
