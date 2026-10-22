-- Ban appeals (JO-052): one appeal per ban. A ban is identified by (guild, user, bans.created_at); a later re-ban after an unban is a new ban.
CREATE TABLE IF NOT EXISTS ban_appeals (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ban_created_at TIMESTAMPTZ NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  decided_by TEXT, decision_reason TEXT, decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id, ban_created_at)
);
CREATE INDEX IF NOT EXISTS ban_appeals_guild_status ON ban_appeals (guild_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ban_appeals_user ON ban_appeals (user_id);
