-- Scheduled message sends: compose now, post later (as the author, with the author's permissions re-checked at send time).
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id TEXT,
  content TEXT NOT NULL,
  reply_to TEXT,
  send_at TIMESTAMPTZ NOT NULL,
  -- pending -> sending (claimed by one node) -> sent | failed; canceled by the author while pending
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','canceled')),
  error TEXT,
  sent_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scheduled_messages_due ON scheduled_messages (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_messages_author ON scheduled_messages (author_id, status, send_at);
