-- Go Live: viewers a streamer (or a moderator) kicked off a stream. Lives as long as the stream; the rows are deleted when it ends.
CREATE TABLE IF NOT EXISTS stream_viewer_kicks (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  streamer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kicked_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, streamer_id, user_id)
);
