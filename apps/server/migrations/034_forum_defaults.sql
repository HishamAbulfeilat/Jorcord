-- Forum channel defaults: post sort order, forum layout, and the reaction auto-added to every new post.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_sort_order TEXT NOT NULL DEFAULT 'latest_activity';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_forum_layout TEXT NOT NULL DEFAULT 'list';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_reaction_emoji TEXT;
