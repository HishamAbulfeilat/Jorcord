-- Public user flags/badges (bitfield, see UserFlags in @jorcord/shared). Staff-assigned; bots get BOT_HTTP_INTERACTIONS-style flags at read time.
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_flags INTEGER NOT NULL DEFAULT 0;
