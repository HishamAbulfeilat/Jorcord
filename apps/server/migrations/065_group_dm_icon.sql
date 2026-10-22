-- Group DM icon (an asset URL, like guild icons).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS icon TEXT;
