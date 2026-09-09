SELECT
  (SELECT count(*) FROM contacts WHERE outreach_angle = 'leads_incentive' AND pipeline = 'Outreach' AND stage = 'Sequence Active') AS leads_incentive_active,
  (SELECT count(*) FROM contacts WHERE outreach_angle = 'free_website'    AND pipeline = 'Outreach' AND stage = 'Sequence Active') AS free_website_remaining,
  (SELECT count(*) FROM contact_sequences cs JOIN sequences s ON s.id = cs.sequence_id WHERE s.name = 'Outreach — Leads Incentive' AND cs.status = 'active' AND cs.current_step = 0) AS new_step1_sequences,
  (SELECT count(*) FROM message_queue mq JOIN contacts c ON c.id = mq.contact_id WHERE mq.status = 'pending' AND c.outreach_angle = 'leads_incentive' AND (mq.metadata->>'step_order')::int = 1) AS step1_queued;
