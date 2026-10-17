-- Membership screening (pending members), two-colour profile themes.
ALTER TABLE members ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_colors JSONB;
CREATE INDEX IF NOT EXISTS users_status_expiry_idx ON users (((custom_status->>'expiresAt'))) WHERE custom_status ? 'expiresAt';
