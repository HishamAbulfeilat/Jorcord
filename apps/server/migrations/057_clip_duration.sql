-- Clips may be longer than 30 s now (the cap is CLIP_MAX_SECONDS, default 120, at most 600): widen the stored-duration check.
-- The real limit is enforced by routes/clips.ts; this is only a sanity bound on the column.
ALTER TABLE clips DROP CONSTRAINT IF EXISTS clips_duration_seconds_check;
ALTER TABLE clips DROP CONSTRAINT IF EXISTS clips_duration_range_check;
ALTER TABLE clips ADD CONSTRAINT clips_duration_range_check CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds <= 600));
