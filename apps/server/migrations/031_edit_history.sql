-- Message edit history (R19): prior versions of a message's content, stored on every content edit.
-- The current content stays on `messages`; history is read via GET /channels/:id/messages/:mid/edits.
CREATE TABLE IF NOT EXISTS message_edits (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_edits_message_idx ON message_edits (message_id, id DESC);
