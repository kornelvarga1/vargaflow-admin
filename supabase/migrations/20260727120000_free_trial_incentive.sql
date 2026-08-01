-- Free Trial Incentive: third outreach angle, same frame as Free Website / Leads Incentive.
-- Copy is placeholder — real messages TBD. Seeded with one step each so
-- enroll-outreach / flow-outreach-warm-enroll don't 500 with "sequence has no steps",
-- but the placeholder text makes it obvious this isn't ready for real contacts yet.

INSERT INTO public.sequences (name, pipeline, stage, is_active)
SELECT 'Outreach — Free Trial Incentive', 'outreach', 'manual_free_trial_incentive', true
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = 'Outreach — Free Trial Incentive');

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 1, 0, 0, 'sms', '[PLACEHOLDER — Free Trial Incentive opener. Do not send. Replace before enrolling real contacts.]'
FROM public.sequences s
WHERE s.name = 'Outreach — Free Trial Incentive'
  AND NOT EXISTS (
    SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 1
  );

-- Warm follow-up sequence (mirrors Leads Incentive's warm path — see 20260602120000_leads_incentive_v2.sql).
-- anchor_timing=true: step times are anchored to enrollment trigger time, not send time.
INSERT INTO public.sequences (name, pipeline, stage, is_active, anchor_timing)
SELECT 'Outreach — Free Trial Incentive (Warm)', 'outreach', 'warm_free_trial_incentive', true, true
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = 'Outreach — Free Trial Incentive (Warm)');

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 1, 0, 0, 'sms', '[PLACEHOLDER — Free Trial Incentive warm opener. Do not send. Replace before enrolling real contacts.]'
FROM public.sequences s
WHERE s.name = 'Outreach — Free Trial Incentive (Warm)'
  AND NOT EXISTS (
    SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 1
  );
