-- Reversible self-service disable, display-name style, per-thread notification level, welcome waves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name_style JSONB;

ALTER TABLE notification_settings DROP CONSTRAINT IF EXISTS notification_settings_scope_check;
ALTER TABLE notification_settings ADD CONSTRAINT notification_settings_scope_check CHECK (scope IN ('guild','channel','thread'));

CREATE TABLE IF NOT EXISTS join_waves (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
