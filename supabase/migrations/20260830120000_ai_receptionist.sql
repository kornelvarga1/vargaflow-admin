-- AI Receptionist: fourth outreach angle, targeting the 1,756 contacts parked in
-- Cold List since 2026-08-16 (pulled back from free_trial_incentive before any sends).
-- Copy below is a first-draft placeholder Kornel plans to rewrite/optimize himself —
-- functional and approved to enroll against, not final.

INSERT INTO public.sequences (name, pipeline, stage, is_active)
SELECT 'Outreach — AI Receptionist', 'outreach', 'manual_ai_receptionist', true
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = 'Outreach — AI Receptionist');

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 1, 0, 0, 'sms', 'Hey it''s Kornel, new idea this time. Built an AI that answers your phone 24/7 and books the job while you''re on a roof or driving. Call it yourself and see: (213) 238-5364. Not selling anything in this text, just want you to hear it work.'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 1);

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 2, 24, 0, 'sms', 'No pressure. But if you missed a call this week, that''s a job the AI would''ve booked instead. Number again if you want to try it: (213) 238-5364.'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 2);

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 3, 72, 0, 'sms', 'Last one from me. If you''re ever tired of losing calls to voicemail, call (213) 238-5364 and hear it for yourself. Otherwise I''ll leave you alone.'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 3);

-- Warm follow-up: enrolled manually once Kornel sees a positive reply (same pattern as
-- free_trial_incentive's warm path — no automated 0h step, close motion is a call with him).
INSERT INTO public.sequences (name, pipeline, stage, is_active, anchor_timing)
SELECT 'Outreach — AI Receptionist (Warm)', 'outreach', 'warm_ai_receptionist', true, true
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = 'Outreach — AI Receptionist (Warm)');

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 1, 24, 0, 'sms', 'Glad you tried it out. Want to jump on a quick call so I can get this running on your actual line?'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist (Warm)'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 1);

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 2, 72, 0, 'sms', 'No rush, happy to walk you through pricing and setup whenever works for you.'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist (Warm)'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 2);

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 3, 120, 0, 'sms', 'Still interested? If it''s timing, just tell me when to check back and I''ll disappear until then.'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist (Warm)'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 3);

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, 4, 192, 0, 'sms', 'Last one from me. If you want it running on your line, here''s my calendar: {{demo_calendar_link}}. Otherwise I''ll leave you be.'
FROM public.sequences s
WHERE s.name = 'Outreach — AI Receptionist (Warm)'
  AND NOT EXISTS (SELECT 1 FROM public.sequence_steps ss WHERE ss.sequence_id = s.id AND ss.step_order = 4);
