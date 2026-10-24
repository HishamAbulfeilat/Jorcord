-- Report abuse throttling looks a reporter's recent reports up; duplicate folding looks them up by canonical report.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reports_reporter_idx ON reports (reporter_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS reports_canonical_idx ON reports (canonical_id) WHERE canonical_id IS NOT NULL;
-- Retention sweeps delete old edit history by age.
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_edits_age_idx ON message_edits (edited_at);
