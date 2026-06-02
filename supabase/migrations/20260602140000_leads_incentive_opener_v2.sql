-- Update cold sequence opener (shorter, no apology, acknowledges randomness in 4 words)
UPDATE public.sequence_steps
SET message_template = 'Hey, {{my_name}} here — random text, I know. You taking on new work right now, or pretty much booked up? (say ''byebye'' and I''ll leave you alone)'
WHERE step_order = 1
  AND sequence_id = (SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive');

-- Remove video step from warm sequence (Kornél sends video manually before triggering).
-- Warm sequence now starts with W1 (+5h nudge) as step 1.
DELETE FROM public.sequence_steps
WHERE step_order = 1
  AND sequence_id = (SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive (Warm)');

-- Renumber remaining steps 2-7 → 1-6 (delays stay the same — still anchored to trigger time)
UPDATE public.sequence_steps
SET step_order = step_order - 1
WHERE sequence_id = (SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive (Warm)')
  AND step_order > 1;
