-- Private threads: visible only to their members (plus MANAGE_THREADS holders). `thread_invitable` = any member may add others.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS thread_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS thread_invitable BOOLEAN NOT NULL DEFAULT true;
