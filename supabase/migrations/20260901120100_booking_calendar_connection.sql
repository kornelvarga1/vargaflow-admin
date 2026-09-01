-- Google Calendar OAuth connection for the self-built booking system.
-- Deliberately a separate table from voice_agents — this stores Kornél's own
-- personal calendar for the website sales-call booking, not a client's
-- business calendar for the AI voice receptionist.
--
-- Run via Supabase Dashboard → SQL Editor (not `supabase db push`).

BEGIN;

CREATE TABLE IF NOT EXISTS public.booking_calendar_connection (
  business_id uuid PRIMARY KEY,                  -- ADMIN_BUSINESS_ID in practice
  google_calendar_id text NOT NULL DEFAULT 'primary',
  google_refresh_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.booking_calendar_connection ENABLE ROW LEVEL SECURITY;
-- No policies added: anon/authenticated roles get zero access by default.
-- Mirrors voice_agents' precedent exactly — edge functions use the
-- service_role key, which bypasses RLS entirely, so this table (including
-- the OAuth refresh token) is never reachable from the browser/client apps.

COMMIT;
