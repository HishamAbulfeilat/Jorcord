-- Rich presence: current activities (transient, cleared when the last gateway session goes away).
ALTER TABLE users ADD COLUMN IF NOT EXISTS activities JSONB NOT NULL DEFAULT '[]';
