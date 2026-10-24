-- Third-party embedded activities (iframe apps). The app registers an https activity_url; its origin is the only one allowed in the frame.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS activity_url TEXT;
-- A running embedded activity is a channel_activities row with kind 'app' (one per application per channel).
ALTER TABLE channel_activities ADD COLUMN IF NOT EXISTS application_id TEXT REFERENCES applications(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS channel_activities_live_uq;
CREATE UNIQUE INDEX IF NOT EXISTS channel_activities_live_uq ON channel_activities (channel_id, kind, (COALESCE(application_id, '')));
