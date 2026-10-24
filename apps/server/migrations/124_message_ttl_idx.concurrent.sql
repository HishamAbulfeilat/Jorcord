CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_expires_idx ON messages (expires_at) WHERE expires_at IS NOT NULL;
