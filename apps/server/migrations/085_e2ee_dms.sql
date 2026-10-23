-- Opt-in end-to-end encrypted 1:1 DMs ("secret chats", docs/E2EE_DMS.md).
-- The server stores only the public half of each device identity and the ciphertext envelopes that clients put in messages.content.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS e2ee_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- base64url of the raw uncompressed P-256 ECDH public key (65 bytes); validated as a point on the curve before it is stored
  public_key TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  -- a revoked device is never listed again and its envelopes are refused
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS e2ee_devices_user_key_uq ON e2ee_devices (user_id, public_key);
CREATE INDEX IF NOT EXISTS e2ee_devices_active_idx ON e2ee_devices (user_id) WHERE revoked_at IS NULL;
