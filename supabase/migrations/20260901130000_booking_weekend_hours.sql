-- Booking hours precision fix + separate weekend window.
-- booking_hours_start/booking_hours_end previously stored whole hours (9, 17);
-- redefined to store minutes-from-midnight so half-hour boundaries (e.g.
-- 20:30) are representable. Existing hour-based values are converted in
-- place. Also adds a separate weekend window since bookable hours can
-- differ from weekdays (e.g. evenings on weekdays, afternoons on weekends).
--
-- Run via Supabase Dashboard → SQL Editor (not `supabase db push`).

BEGIN;

-- Convert any existing hour-based values (0-23 range) to minutes-from-midnight.
-- Guarded so re-running this migration doesn't double-convert.
UPDATE public.settings
SET booking_hours_start = booking_hours_start * 60,
    booking_hours_end = booking_hours_end * 60
WHERE booking_hours_start IS NOT NULL AND booking_hours_start <= 23
  AND booking_hours_end IS NOT NULL AND booking_hours_end <= 23;

ALTER TABLE public.settings
  ALTER COLUMN booking_hours_start SET DEFAULT 540,  -- 9:00
  ALTER COLUMN booking_hours_end SET DEFAULT 1020;   -- 17:00

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS booking_weekend_days_of_week integer[] NOT NULL DEFAULT ARRAY[0,6],
  ADD COLUMN IF NOT EXISTS booking_weekend_hours_start integer,
  ADD COLUMN IF NOT EXISTS booking_weekend_hours_end integer;

COMMENT ON COLUMN public.settings.booking_hours_start IS 'Weekday window start, minutes from midnight (e.g. 1080 = 18:00).';
COMMENT ON COLUMN public.settings.booking_hours_end IS 'Weekday window end, minutes from midnight.';
COMMENT ON COLUMN public.settings.booking_weekend_hours_start IS 'Weekend window start, minutes from midnight. NULL = no separate weekend window.';
COMMENT ON COLUMN public.settings.booking_weekend_hours_end IS 'Weekend window end, minutes from midnight.';

COMMIT;
