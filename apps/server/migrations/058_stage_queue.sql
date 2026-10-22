-- Stage channels: the raised-hand queue is persisted (ordering survives reconnects and restarts) and moderators can block a member from speaking.
-- seq orders the queue (first come, first served); a hand stays in the queue while its owner is briefly away: left_at marks the moment they left
-- and the sweeper drops rows that stayed away longer than the grace period.
CREATE TABLE IF NOT EXISTS stage_hand_queue (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq BIGSERIAL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  anonymous BOOLEAN NOT NULL DEFAULT false,
  left_at TIMESTAMPTZ,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS stage_hand_queue_order_idx ON stage_hand_queue (channel_id, seq);

-- Members a moderator barred from raising their hand / speaking in a stage channel. Cleared when the stage instance ends.
CREATE TABLE IF NOT EXISTS stage_speaker_blocks (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
