-- GIF favorites / saved media (any GIF or image URL a user starred).
CREATE TABLE IF NOT EXISTS gif_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  preview TEXT,
  title TEXT,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)
);
CREATE INDEX IF NOT EXISTS gif_favorites_user_idx ON gif_favorites (user_id, created_at DESC);
