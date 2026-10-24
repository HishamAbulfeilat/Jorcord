-- Forum / media channels: slowmode applied to every newly created post (thread).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_thread_slowmode INTEGER NOT NULL DEFAULT 0;
