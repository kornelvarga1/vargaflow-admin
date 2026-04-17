-- Add dnd_email flag to contacts so the /unsubscribe endpoint can set it and
-- cron-message-sender / all email-sending flows can skip sending to opted-out
-- recipients. Parallel to dnd_sms.
-- Required for CAN-SPAM / GDPR compliance.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dnd_email boolean NOT NULL DEFAULT false;
