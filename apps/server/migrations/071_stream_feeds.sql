-- Per-server announcements for a Twitch channel going live or a YouTube channel publishing a video.
CREATE TABLE IF NOT EXISTS stream_feeds (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('twitch','youtube')),
  -- Twitch login (lowercase) or YouTube channel id (UC...)
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
  -- the creator could mention a non-mentionable role (MENTION_EVERYONE); re-checked against their current permissions on every post
  mention_privileged BOOLEAN NOT NULL DEFAULT false,
  mention_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- dedupe: Twitch stream id / YouTube video id of the last announcement, and when it was published
  last_item_id TEXT,
  last_item_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_announced_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS stream_feeds_due ON stream_feeds (next_check_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS stream_feeds_channel ON stream_feeds (channel_id);
