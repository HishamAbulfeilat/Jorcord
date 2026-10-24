-- Sitemaps and the public index only ever look at the (few) opted-in channels.
CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_public_web_idx ON channels (guild_id) WHERE public_web;
