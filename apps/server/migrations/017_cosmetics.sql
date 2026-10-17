-- Cosmetics (free catalog ids) and server tags.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_decoration TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_effect TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_plate TEXT;
-- the tag the user wears, denormalised so every user object can carry it: {"guildId","tag","badge"}
ALTER TABLE users ADD COLUMN IF NOT EXISTS server_tag JSONB;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS tag TEXT;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS tag_badge TEXT;
