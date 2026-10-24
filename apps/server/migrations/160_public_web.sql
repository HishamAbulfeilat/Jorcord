-- Public, indexable web pages for community forum / announcement channels (docs/PUBLIC_PAGES.md).
-- Everything is opt-in and OFF by default; ADD COLUMN with a constant default is a metadata-only change on Postgres 11+.
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS public_web BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS public_noindex BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS public_web BOOLEAN NOT NULL DEFAULT false;
