-- Patch pending step-1 messages that still have the old opener text.
-- Rebuilds message_content directly so it matches the current template.
UPDATE public.message_queue
SET message_content =
  'Hey, ' ||
  (SELECT my_name FROM public.settings WHERE business_id = '79036fbb-997c-4f7b-b46f-ccc97a64c38d') ||
  ' here, random text I know. You taking on new work right now, or pretty much booked up? (say ''byebye'' and I''ll leave you alone)'
WHERE status = 'pending'
  AND (metadata->>'step_order')::int = 1
  AND message_content LIKE '%out-of-the-blue%';
