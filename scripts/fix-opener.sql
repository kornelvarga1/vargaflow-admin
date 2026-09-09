UPDATE public.sequence_steps
SET message_template = 'Hey, {{my_name}} here, random text I know. You taking on new work right now, or pretty much booked up? (say ''byebye'' and I''ll leave you alone)'
WHERE step_order = 1
  AND sequence_id = (SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive');
