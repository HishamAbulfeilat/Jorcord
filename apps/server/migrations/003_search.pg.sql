-- Postgres-only (skipped on embedded PGlite, which keeps using ILIKE): full-text search over message content.
-- 'simple' config = no stemming or stop words; queries match word prefixes (`term:*`). Punctuation is flattened first so "foo.com" indexes as foo + com.
CREATE INDEX IF NOT EXISTS messages_content_fts_idx ON messages USING GIN (to_tsvector('simple', regexp_replace(content, '[^[:alnum:]]+', ' ', 'g')));
