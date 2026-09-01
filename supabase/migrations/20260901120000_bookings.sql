-- Self-built booking system (replaces Calendly on vargaflow-website).
-- One row per sales-call booking made through the public booking widget.
-- Populated by the book-call edge function (writes via service_role,
-- bypasses RLS), updated by manage-booking on reschedule/cancel.
--
-- Run via Supabase Dashboard → SQL Editor (not `supabase db push`).

BEGIN;

CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid,                              -- nullable, matches contacts/sms_optins convention
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',      -- 'confirmed' | 'cancelled'
  google_event_id text,
  meeting_link text,                             -- snapshot of settings.zoom_personal_link at booking time
  reschedule_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_contact_id ON public.bookings(contact_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON public.bookings(start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON public.bookings(status);

-- Cheap double-book guard for the exact-same-instant double-click/double-tab
-- race. Doesn't stop overlapping-but-offset bookings — book-call/manage-booking
-- also recheck Google Calendar freebusy immediately before writing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_start_time_confirmed
  ON public.bookings(start_time) WHERE status = 'confirmed';

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin can manage all bookings" ON public.bookings;
CREATE POLICY "Admin can manage all bookings"
  ON public.bookings
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

COMMIT;
