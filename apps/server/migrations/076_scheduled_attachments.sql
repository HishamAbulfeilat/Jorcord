-- Scheduled messages can carry attachments: the uploads are claimed (files.attached = true) when scheduled and released again if the send is canceled, edited away or fails.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
