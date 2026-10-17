-- Every state-changing request the super admin makes while god mode is on, plus god-mode on/off.
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, path TEXT NOT NULL, status INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit (created_at DESC);
