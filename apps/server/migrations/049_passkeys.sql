-- WebAuthn passkeys (JO-051). Public keys are stored as base64url text; counters are checked on every assertion.
CREATE TABLE IF NOT EXISTS user_passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports JSONB NOT NULL DEFAULT '[]',
  device_type TEXT, backed_up BOOLEAN NOT NULL DEFAULT false,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_passkeys_user ON user_passkeys (user_id);

-- Single-use, short-lived challenges (registration, login, MFA). Consumed with DELETE ... RETURNING.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,           -- register | login | mfa | mfa_ticket
  user_id TEXT,
  ref TEXT,                        -- mfa: the ticket challenge this assertion challenge belongs to
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_exp ON webauthn_challenges (expires_at);
