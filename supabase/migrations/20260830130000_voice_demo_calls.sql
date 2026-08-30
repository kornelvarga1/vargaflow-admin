-- Logs every call to the two shared voice-demo numbers (Jake/plumbing,
-- Ryan/roofing) so a prospect who calls the demo but never replies to SMS
-- still shows up as an interest signal. Written by the voice-call-webhook
-- edge function (service_role only — Retell's agent-level webhook_url).

CREATE TABLE public.voice_demo_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id text UNIQUE NOT NULL,
  agent_id text,
  to_number text,
  from_number text,
  from_number_normalized text,
  business_id uuid REFERENCES public.businesses(id),
  matched_contact_id uuid REFERENCES public.contacts(id),
  call_status text,
  start_timestamp timestamptz,
  end_timestamp timestamptz,
  duration_ms integer,
  disconnection_reason text,
  transcript text,
  recording_url text,
  call_summary text,
  user_sentiment text,
  call_successful boolean,
  raw_event jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_demo_calls_from_number_normalized_idx ON public.voice_demo_calls (from_number_normalized);
CREATE INDEX voice_demo_calls_matched_contact_id_idx ON public.voice_demo_calls (matched_contact_id);
CREATE INDEX voice_demo_calls_start_timestamp_idx ON public.voice_demo_calls (start_timestamp DESC);

ALTER TABLE public.voice_demo_calls ENABLE ROW LEVEL SECURITY;

-- Admin-only, same pattern as onboarding_submissions/dnc_list (20260418120000_security_lockdown.sql).
-- Writes happen via edge function with service_role, so no anon/authenticated write policy needed.
CREATE POLICY "Admin can manage voice demo calls"
  ON public.voice_demo_calls
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
