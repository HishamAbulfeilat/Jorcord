-- OAuth-verified profile connections (Twitch, YouTube). Only the provider's stable user id is kept, never an access/refresh token.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS provider_user_id TEXT;
-- one external account can be proven by one Jorcord account only
CREATE UNIQUE INDEX IF NOT EXISTS connections_provider_user ON connections (type, provider_user_id) WHERE provider_user_id IS NOT NULL;

-- Pending authorize requests. `state` is stored as a SHA-256 hash, single use (deleted on the callback), bound to the user that started it
-- and to the browser that started it (`binding_hash` = hash of a cookie nonce), short lived.
CREATE TABLE IF NOT EXISTS connection_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  binding_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_oauth_states_user ON connection_oauth_states (user_id);
CREATE INDEX IF NOT EXISTS connection_oauth_states_exp ON connection_oauth_states (expires_at);
