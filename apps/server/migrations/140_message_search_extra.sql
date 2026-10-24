-- Searchable text of a message's embeds (title, description, url, site, author, footer) and attachments (filename, alt text).
-- Maintained by a trigger so every write path (send, bot embeds, link unfurl, safety alerts, edits) stays covered.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_extra TEXT;

CREATE OR REPLACE FUNCTION messages_search_extra_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_extra := NULLIF(btrim(concat_ws(' ',
    (SELECT string_agg(concat_ws(' ', e->>'title', e->>'description', e->>'url', e->>'siteName', e->>'author', e->>'footer'), ' ')
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.embeds) = 'array' THEN NEW.embeds ELSE '[]'::jsonb END) e),
    (SELECT string_agg(concat_ws(' ', a->>'filename', a->>'description'), ' ')
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.attachments) = 'array' THEN NEW.attachments ELSE '[]'::jsonb END) a)
  )), '');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS messages_search_extra_trg ON messages;
CREATE TRIGGER messages_search_extra_trg BEFORE INSERT OR UPDATE OF embeds, attachments ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_search_extra_fn();

-- Backfill: only rows that have embeds or attachments.
UPDATE messages SET embeds = embeds WHERE embeds <> '[]'::jsonb OR attachments <> '[]'::jsonb;
