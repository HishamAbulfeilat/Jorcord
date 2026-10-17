-- Instance super admin (identity comes from SUPER_ADMIN_USER_ID, never the DB): lets the admin disable accounts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
