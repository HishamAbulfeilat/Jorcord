-- Self-attested "I am 18 or older" confirmation required to read or post in age-restricted (nsfw) server channels.
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;
