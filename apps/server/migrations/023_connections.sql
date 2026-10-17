-- Profile connections (self-declared links with optional proof-of-control verification).
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  handle TEXT NOT NULL,
  url TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  verified BOOLEAN NOT NULL DEFAULT false,
  verify_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, handle)
);
CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);
