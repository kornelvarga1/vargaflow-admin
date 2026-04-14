-- Table to store contractor onboarding form submissions.
-- Populated by the flow-ob-form-submitted edge function when a client
-- submits the onboarding form at vargaflow.com/onboarding-form.
-- Read by the admin UI on the contact profile page.

CREATE TABLE IF NOT EXISTS onboarding_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  business_id uuid,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_contact_id
  ON onboarding_submissions(contact_id);

CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_business_id
  ON onboarding_submissions(business_id);
