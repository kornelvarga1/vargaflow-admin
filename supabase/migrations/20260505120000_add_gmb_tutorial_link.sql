-- Adds gmb_tutorial_link to settings so the GMB-access tutorial URL can be
-- referenced via the {{gmb_tutorial_link}} placeholder in onboarding flows
-- (currently OB Flow #1 client-signup email + OB Flow #3 form-submitted SMS).

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS gmb_tutorial_link text NOT NULL DEFAULT '';
