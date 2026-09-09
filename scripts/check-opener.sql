SELECT count(*) AS patched
FROM public.message_queue
WHERE status = 'pending'
  AND (metadata->>'step_order')::int = 1
  AND message_content LIKE '%random text I know%';
