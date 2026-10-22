-- Read-side indexes for hot list endpoints (channel messages, guild members, channel sidebar,
-- threads, reactions and the audit log). Safe to re-run: every statement is IF NOT EXISTS.

-- messages: a user's recent messages page filters by author and needs global id order
-- (messages_author_idx puts channel_id before id, so it cannot serve this order).
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_author_recent_idx ON messages (author_id, id);

-- messages: moderation queries scoped to a guild and an author (bulk delete, prune, automod
-- counters, linked-role message counts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_guild_author_idx ON messages (guild_id, author_id, id);

-- members: guild member lists ordered by join time (READY, admin, widget) and a user's guilds
-- ordered by joined_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS members_guild_joined_idx ON members (guild_id, joined_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS members_user_joined_idx ON members (user_id, joined_at);

-- channels: guild channel lists are ordered by position (visibleChannelRows, sidebar, admin view).
CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_guild_position_idx ON channels (guild_id, position, id);

-- channels: thread lists filter one parent by archive state and order by latest activity.
CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_thread_order_idx ON channels (parent_id, archived, last_message_id DESC NULLS LAST, id DESC) WHERE type = 'thread';

-- reactions: a user's reactions are paged newest-first for account data export.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reactions_user_created_idx ON reactions (user_id, created_at DESC);

-- audit_log: audit pages filter by actor, action name or target and page newest-first by id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_guild_actor_idx ON audit_log (guild_id, actor_id, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_guild_action_name_idx ON audit_log (guild_id, action, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_guild_target_recent_idx ON audit_log (guild_id, target_id, id);

-- read_states: channel deletion cascades through this table; the primary key starts with user_id,
-- so the channel_id side needs its own index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS read_states_channel_idx ON read_states (channel_id);
