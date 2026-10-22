-- Account deletion grace period: DELETE /users/@me sets the due date, logging in again clears it, the sweeper erases accounts past it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_due_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_deletion_due_idx ON users (deletion_due_at) WHERE deletion_due_at IS NOT NULL AND deleted_at IS NULL;
