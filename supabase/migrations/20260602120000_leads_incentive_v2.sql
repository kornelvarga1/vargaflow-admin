-- Leads Incentive v2: new cold sequence copy + warm follow-up sequence

-- Add anchor_timing flag to sequences.
-- When true, cron-message-sender calculates all step scheduled_at times as
-- (contact_sequence.started_at + cumulative_delay) instead of the default
-- (previous_step_actual_sent_at + gap). Also enables send-window enforcement
-- for follow-up steps (defers to next 9am if calculated time is outside window).
ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS anchor_timing boolean NOT NULL DEFAULT false;

-- Replace cold sequence steps with new copy and timings.
-- Steps are cumulative from enrollment:
--   Step 1: immediate (0h)
--   Step 2: +2h quick nudge
--   Step 3: +24h (same clock-time as opener, next day)
DELETE FROM public.sequence_steps
WHERE sequence_id IN (
  SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive'
);

INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, v.step_order, v.delay_hours, v.delay_minutes, 'sms', v.message_template
FROM public.sequences s
CROSS JOIN (VALUES
  (1,  0, 0, 'Hey, {{my_name}} here. Sorry for the out-of-the-blue text. Came across your business on Google and figured I''d reach out. Quick one: you booked solid right now, or open to taking on more work? (just say ''byebye'' and I''ll leave you alone)'),
  (2,  2, 0, 'Not sure if that came through? You taking on new work right now, or all booked up?'),
  (3, 24, 0, 'Last nudge, promise. Here''s my site if you wanna see if I''m not a scammer: {{website_url}}. If you''re ever open to more work, just say the word.')
) AS v(step_order, delay_hours, delay_minutes, message_template)
WHERE s.name = 'Outreach — Leads Incentive';

-- Seed warm sequence (idempotent).
-- anchor_timing=true: all step times are anchored to enrollment trigger time.
-- The warm sequence is enrolled manually when Kornél drags a replied contact
-- to "Interested – Positive Reply" in the OutreachBoard.
INSERT INTO public.sequences (name, pipeline, stage, is_active, anchor_timing)
SELECT 'Outreach — Leads Incentive (Warm)', 'outreach', 'warm_leads_incentive', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.sequences WHERE name = 'Outreach — Leads Incentive (Warm)'
);

-- Seed warm sequence steps.
-- Delays are cumulative from enrollment trigger time.
-- Step 1 = video (immediate), then W1-W6 anchored to that trigger time:
--   Step 1 (video): 0h   — fires immediately
--   Step 2 (W1):    5h   — did you watch it?
--   Step 3 (W2):   24h   — book a call (same clock-time as video, next day)
--   Step 4 (W3):   72h   — did the video land? (+2d from W2)
--   Step 5 (W4):  120h   — mock up offer (+2d from W3)
--   Step 6 (W5):  192h   — am I in the right place? (+3d from W4)
--   Step 7 (W6):  264h   — breakup (+3d from W5)
INSERT INTO public.sequence_steps (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
SELECT s.id, v.step_order, v.delay_hours, 0, 'sms', v.message_template
FROM public.sequences s
CROSS JOIN (VALUES
  (1,   0, 'Awesome. Easiest way to show you exactly what I mean is this: a short video breaking down exactly what I do. I kept it to a minimum, I promise 😅 {{software_explanation_video}}'),
  (2,   5, 'Did you get a chance to watch it? Curious what you think about it?'),
  (3,  24, 'If the video made sense, you can book a call with me anytime using this link: {{demo_calendar_link}}. I''ll take a look at your business and see if there''s anything I can do to help.'),
  (4,  72, 'Did the video land, or did I lose you halfway? Happy to answer anything right here over text too. And here''s my site if you wanna see if I''m legit: {{website_url}}.'),
  (5, 120, 'Want me to just mock up what your site and setup would actually look like? Takes me 10 min and you can see it either way.'),
  (6, 192, 'Am I in the right place? I really hope this is you with the home service business I''ve been texting. If not, that would be a little awkward lol'),
  (7, 264, 'You''re breaking my heart 💔 You never told me what you thought about the video I sent over. Here it is one last time with my calendar if you want to chat: {{demo_calendar_link}}. If not, all good, I don''t want to bother you.')
) AS v(step_order, delay_hours, message_template)
WHERE s.name = 'Outreach — Leads Incentive (Warm)'
  AND NOT EXISTS (
    SELECT 1 FROM public.sequence_steps ss
    WHERE ss.sequence_id = s.id AND ss.step_order = v.step_order
  );
