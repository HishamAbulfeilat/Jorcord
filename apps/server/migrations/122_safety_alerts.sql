-- Safety alerts: raid and mass-DM detections post to a moderator channel.
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS safety_alerts_channel_id TEXT;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS safety_alerts JSONB NOT NULL DEFAULT '{}';
