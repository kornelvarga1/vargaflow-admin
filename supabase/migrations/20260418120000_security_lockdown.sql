-- Security lockdown — 2026-04-18 pre-launch audit.
-- Closes anon-write/read vulnerabilities found in Section 10.1 (RLS audit).
-- Run via Supabase Dashboard → SQL Editor (not `supabase db push`).
--
-- What this does:
--   1. Enables RLS on onboarding_submissions + scopes reads to admin/own-business.
--      (Writes happen via edge function with service_role, so no anon policy needed.)
--   2. Replaces wide-open dnc_list policy with admin-write + own-business-read.
--   3. Replaces "service role full access" on push_subscriptions (mistakenly granted
--      to public) with an admin-only policy.
--   4. Replaces "authenticated USING (true)" on client_sequence_templates with
--      admin-write + authenticated-read-own.
--   5. Locks onboarding-photos storage bucket to image/* under 25MB.

BEGIN;

-- ============================================================================
-- 1. onboarding_submissions — enable RLS, admin + business-scoped reads
-- ============================================================================
ALTER TABLE public.onboarding_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin can manage all onboarding submissions" ON public.onboarding_submissions;
CREATE POLICY "Admin can manage all onboarding submissions"
  ON public.onboarding_submissions
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DROP POLICY IF EXISTS "Users can view own business onboarding submissions" ON public.onboarding_submissions;
CREATE POLICY "Users can view own business onboarding submissions"
  ON public.onboarding_submissions
  FOR SELECT
  TO authenticated
  USING (business_id IN (SELECT business_id FROM public.profiles WHERE profiles.id = auth.uid()));

-- ============================================================================
-- 2. dnc_list — lock to admin-write + own-business-read
-- ============================================================================
DROP POLICY IF EXISTS "Allow all access to dnc_list" ON public.dnc_list;

DROP POLICY IF EXISTS "Admin can manage dnc_list" ON public.dnc_list;
CREATE POLICY "Admin can manage dnc_list"
  ON public.dnc_list
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DROP POLICY IF EXISTS "Users can view own business dnc_list" ON public.dnc_list;
CREATE POLICY "Users can view own business dnc_list"
  ON public.dnc_list
  FOR SELECT
  TO authenticated
  USING (business_id IN (SELECT business_id FROM public.profiles WHERE profiles.id = auth.uid()));

-- ============================================================================
-- 3. push_subscriptions — admin-only (remove mis-granted public policy)
-- ============================================================================
DROP POLICY IF EXISTS "service role full access" ON public.push_subscriptions;

DROP POLICY IF EXISTS "Admin can manage push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Admin can manage push subscriptions"
  ON public.push_subscriptions
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

-- ============================================================================
-- 4. client_sequence_templates — admin-write, authenticated-read-own-or-global
-- ============================================================================
DROP POLICY IF EXISTS "Authenticated users can manage client templates" ON public.client_sequence_templates;
DROP POLICY IF EXISTS "Service role can read client templates" ON public.client_sequence_templates;

DROP POLICY IF EXISTS "Admin can manage client templates" ON public.client_sequence_templates;
CREATE POLICY "Admin can manage client templates"
  ON public.client_sequence_templates
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DROP POLICY IF EXISTS "Users can view own business or global client templates" ON public.client_sequence_templates;
CREATE POLICY "Users can view own business or global client templates"
  ON public.client_sequence_templates
  FOR SELECT
  TO authenticated
  USING (
    business_id IS NULL
    OR business_id IN (SELECT business_id FROM public.profiles WHERE profiles.id = auth.uid())
  );

-- ============================================================================
-- 5. storage: enforce file size + MIME type on onboarding-photos bucket
-- ============================================================================
UPDATE storage.buckets
SET
  file_size_limit = 26214400,  -- 25 MB, matches MAX_FILE_SIZE_MB in OnboardingForm.tsx
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif'
  ]
WHERE id = 'onboarding-photos';

COMMIT;
