-- Add timezone column to contacts so message bodies can render appointment
-- times in the contact's local timezone. Captured from Calendly's
-- invitee.timezone in flow-call-booked; reused by flow-ob-launch-call (and
-- any future time-display flow) so contractors east-to-west see their own
-- local clock time. Fallback to America/New_York when missing.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timezone TEXT;
COMMENT ON COLUMN contacts.timezone IS 'IANA timezone (e.g. America/Los_Angeles). Captured from Calendly invitee.timezone on first booking; used to render appointment times in client-facing SMS/email.';
