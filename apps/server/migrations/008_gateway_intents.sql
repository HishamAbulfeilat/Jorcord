-- Privileged gateway intents (members / presences / message content) the application owner has switched on.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS privileged_intents INTEGER NOT NULL DEFAULT 0;
