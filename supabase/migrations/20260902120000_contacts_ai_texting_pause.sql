-- Human-takeover flag for the new AI text agent (auto-replies to inbound SMS
-- on Kornel's own outreach number). NULL = the AI is actively handling this
-- contact's texts. Non-null = a human (Kornel) has taken over via a manual
-- reply from the CRM, or the agent auto-paused itself (24h reply-loop guard)
-- — the AI stays silent on this contact until the timestamp is cleared.
--
-- Run via Supabase Dashboard -> SQL Editor (not `supabase db push`).

BEGIN;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS ai_texting_paused_at timestamptz;

COMMENT ON COLUMN public.contacts.ai_texting_paused_at IS
  'NULL = AI text agent active for this contact. Set = paused (manual reply sent, or auto-paused by the 24h reply-loop guard) until cleared.';

COMMIT;
