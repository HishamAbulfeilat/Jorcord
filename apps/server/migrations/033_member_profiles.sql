-- Per-server profile overrides: a member may set their own banner, About Me and pronouns for one server.
ALTER TABLE members ADD COLUMN IF NOT EXISTS banner TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS pronouns TEXT;
