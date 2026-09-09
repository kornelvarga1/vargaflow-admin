UPDATE public.sequence_steps
SET message_template = 'Not sure if that came through? Got room for more jobs or pretty much booked out?'
WHERE step_order = 2
  AND sequence_id = (SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive');
