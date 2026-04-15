-- SMS Cold Outreach system

-- dnc_list: global Do-Not-Contact registry, keyed by phone (E.164)
CREATE TABLE IF NOT EXISTS public.dnc_list (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT 'manual',
  source_workflow TEXT,
  business_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.dnc_list ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dnc_list' AND policyname = 'Allow all access to dnc_list'
  ) THEN
    CREATE POLICY "Allow all access to dnc_list" ON public.dnc_list FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dnc_list_phone ON public.dnc_list(phone);

-- Track which outreach angle brought each contact in
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS outreach_angle TEXT;

-- Send-window + per-hour rate limit (global; applied in cron-message-sender)
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS send_window_start SMALLINT NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS send_window_end SMALLINT NOT NULL DEFAULT 19,
  ADD COLUMN IF NOT EXISTS outbound_rate_per_hour INTEGER NOT NULL DEFAULT 60;

-- Seed the two outreach sequences (idempotent without relying on any UNIQUE constraint)
INSERT INTO public.sequences (name, pipeline, stage, is_active)
SELECT 'Outreach — Free Website Incentive', 'outreach', 'manual_free_website', true
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = 'Outreach — Free Website Incentive');

INSERT INTO public.sequences (name, pipeline, stage, is_active)
SELECT 'Outreach — Leads Incentive', 'outreach', 'manual_leads_incentive', true
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = 'Outreach — Leads Incentive');

-- Seed steps for "Outreach — Free Website Incentive"
INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, v.step_order, v.delay_hours, v.delay_minutes, 'sms', v.message_template
FROM public.sequences s
CROSS JOIN (VALUES
  (1,  0,  0, 'Hey man, this is Michael... I was looking you guys up on google and saw that you don''t have a website or anything like that. I know this is kinda random but I went ahead and built you one. Do you wanna see it? just say ''byebye'' if you want me to stop'),
  (2,  0, 54, 'Did you see my last message?'),
  (3, 24, 54, 'Hey, don''t wanna be a hassle but if seeing the awesome website i made for you doesn''t sound bad, let me know and i''ll show you how. If not, all good...')
) AS v(step_order, delay_hours, delay_minutes, message_template)
WHERE s.name = 'Outreach — Free Website Incentive'
  AND NOT EXISTS (
    SELECT 1 FROM public.sequence_steps ss
    WHERE ss.sequence_id = s.id AND ss.step_order = v.step_order
  );

-- Seed steps for "Outreach — Leads Incentive"
INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, v.step_order, v.delay_hours, v.delay_minutes, 'sms', v.message_template
FROM public.sequences s
CROSS JOIN (VALUES
  (1,  0,  0, 'Hey man, this is Michael. I''m looking for one company that can handle 5-15 more jobs in the next 8 weeks... Are you able to take that on? just say ''byebye'' if you want me to stop'),
  (2,  0, 54, 'Did you see my last message?'),
  (3, 24, 54, 'Hey, don''t wanna be a hassle but if an extra 5-15 jobs doesn''t sound bad, let me know and i''ll show you how. If not, all good...')
) AS v(step_order, delay_hours, delay_minutes, message_template)
WHERE s.name = 'Outreach — Leads Incentive'
  AND NOT EXISTS (
    SELECT 1 FROM public.sequence_steps ss
    WHERE ss.sequence_id = s.id AND ss.step_order = v.step_order
  );
