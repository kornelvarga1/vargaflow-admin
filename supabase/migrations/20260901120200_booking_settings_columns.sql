-- Non-secret booking configuration for the self-built booking system.
-- booking_timezone/hours/days describe KORNÉL's own working hours (used
-- server-side to compute which UTC windows are offerable) — never used to
-- render a lead-facing time, which always localizes to the viewer's own
-- browser-detected timezone instead.
--
-- Run via Supabase Dashboard → SQL Editor (not `supabase db push`).

BEGIN;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS zoom_personal_link text,
  ADD COLUMN IF NOT EXISTS booking_timezone text NOT NULL DEFAULT 'Europe/Budapest',
  ADD COLUMN IF NOT EXISTS booking_hours_start integer NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS booking_hours_end integer NOT NULL DEFAULT 17,
  -- 0=Sun, 1=Mon, ... 6=Sat. Default: Mon-Fri.
  ADD COLUMN IF NOT EXISTS booking_days_of_week integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  ADD COLUMN IF NOT EXISTS booking_slot_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS booking_buffer_minutes integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS booking_min_notice_minutes integer NOT NULL DEFAULT 120;

COMMIT;
