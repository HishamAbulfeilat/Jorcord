-- Delegated instance admins. The super admin (env SUPER_ADMIN_USER_ID) is unchanged and is NOT stored here; only the super
-- admin can set this flag (POST/DELETE /admin/users/:id/admin). Default: nobody.
ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_admin_granted_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_admin_granted_at TIMESTAMPTZ;
