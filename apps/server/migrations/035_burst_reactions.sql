-- Burst (super) reactions: a flagged reaction with its own colour, tracked separately from the regular one.
-- A user may hold a normal and a burst reaction for the same emoji, so the primary key gains the burst flag.

ALTER TABLE reactions ADD COLUMN IF NOT EXISTS burst BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reactions ADD COLUMN IF NOT EXISTS burst_color TEXT;

ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_pkey;
ALTER TABLE reactions ADD PRIMARY KEY (message_id, user_id, emoji, burst);

-- Daily-metered burst usage ledger. Rows are never removed when a burst reaction is taken back, so the
-- per-day allowance is not refunded; the count is over the trailing 24 hours.
CREATE TABLE IF NOT EXISTS burst_reaction_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS burst_reaction_usage_user_idx ON burst_reaction_usage (user_id, created_at);
