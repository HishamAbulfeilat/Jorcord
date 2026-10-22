-- Welcome screen of community servers: {"enabled":bool,"description":string|null,"channels":[{"channelId","description","emoji"}]} (max 5 channels).
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS welcome_screen JSONB;
