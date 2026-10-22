-- Role-restricted emoji: when non-empty, only members holding one of these roles may use the emoji (managers always can).
ALTER TABLE emojis ADD COLUMN IF NOT EXISTS role_ids JSONB NOT NULL DEFAULT '[]';
