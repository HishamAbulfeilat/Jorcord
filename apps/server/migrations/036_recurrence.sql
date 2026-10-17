-- Recurrence rules for scheduled events

ALTER TABLE guild_scheduled_events ADD COLUMN IF NOT EXISTS recurrence_rule JSONB;