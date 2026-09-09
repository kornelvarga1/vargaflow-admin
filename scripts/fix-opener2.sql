UPDATE public.sequence_steps
SET message_template = 'Hey, {{my_name}} here, random text I know. You got room for more jobs right now or pretty much booked out? (say ''byebye'' and I''ll leave you alone)'
WHERE step_order = 1
  AND sequence_id = (SELECT id FROM public.sequences WHERE name = 'Outreach — Leads Incentive');

UPDATE public.message_queue
SET message_content =
  'Hey, ' ||
  (SELECT my_name FROM public.settings WHERE business_id = '79036fbb-997c-4f7b-b46f-ccc97a64c38d') ||
  ' here, random text I know. You got room for more jobs right now or pretty much booked out? (say ''byebye'' and I''ll leave you alone)'
WHERE status = 'pending'
  AND (metadata->>'step_order')::int = 1
  AND message_content LIKE '%random text I know%';
