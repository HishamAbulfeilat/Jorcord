-- QR-code login ("remote auth"): short-lived, single-use sessions. Only SHA-256 hashes of the secrets are stored.
CREATE TABLE IF NOT EXISTS remote_auth (
  id TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,            -- secret held by the waiting device (never shown in the QR code)
  scan_hash TEXT NOT NULL,            -- secret carried in the QR code
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | scanned | approved | denied | consumed
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- the authenticated user who scanned
  user_agent TEXT, ip TEXT,           -- of the waiting device, shown on the confirmation prompt
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_auth_expires_idx ON remote_auth (expires_at);
