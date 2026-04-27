-- SMS opt-in submissions from vargaflow.com/sms-optin.
-- Each row is a TCPA paper trail: name, phone, timestamp, IP, user agent,
-- exact consent wording version, and which checkboxes were ticked.
--
-- Populated by the sms-optin-submit edge function (writes via service_role,
-- bypasses RLS). Read by admin / own-business users for compliance lookups.
--
-- Run via Supabase Dashboard → SQL Editor (not `supabase db push`).

BEGIN;

CREATE TABLE IF NOT EXISTS public.sms_optins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid,                                -- nullable — VargaFlow's own business_id can be backfilled later
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,                             -- E.164, e.g. +13075551234
  customer_care_consent boolean NOT NULL DEFAULT false,
  marketing_consent boolean NOT NULL DEFAULT false,
  ip_address text,
  user_agent text,
  consent_text_version text NOT NULL,              -- e.g. "2026-04-27-v1" — proves which exact wording was shown
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_optins_business_id ON public.sms_optins(business_id);
CREATE INDEX IF NOT EXISTS idx_sms_optins_created_at ON public.sms_optins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_optins_phone ON public.sms_optins(phone);

-- RLS: writes via service_role (edge function) bypass RLS, so no anon-write
-- policy needed. Reads scoped to admins or users on the same business —
-- mirrors the onboarding_submissions pattern from 20260418120000_security_lockdown.sql.
ALTER TABLE public.sms_optins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin can manage all sms optins" ON public.sms_optins;
CREATE POLICY "Admin can manage all sms optins"
  ON public.sms_optins
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DROP POLICY IF EXISTS "Users can view own business sms optins" ON public.sms_optins;
CREATE POLICY "Users can view own business sms optins"
  ON public.sms_optins
  FOR SELECT
  TO authenticated
  USING (business_id IN (SELECT business_id FROM public.profiles WHERE profiles.id = auth.uid()));

COMMIT;
