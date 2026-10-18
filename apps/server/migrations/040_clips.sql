-- Clips: a channel can be marked as a clips channel, where video uploads (max 30 s) are posted as normal messages.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_clips_channel BOOLEAN NOT NULL DEFAULT false;

-- One row per clip message. The message id is the clip id: deleting the message removes the clip.
CREATE TABLE IF NOT EXISTS clips (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds <= 30)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_channel_idx ON clips (channel_id, message_id);
