-- Asynchronous data export (JO-054). The zip lives in the normal storage backend under `storage_key`; it is never registered in `files`,
-- so it can only be fetched through the signed, expiring download route.
CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  storage_key TEXT, size_bytes BIGINT, counts JSONB, error TEXT,
  downloads INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS export_jobs_user ON export_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS export_jobs_expiry ON export_jobs (expires_at) WHERE status = 'ready';
