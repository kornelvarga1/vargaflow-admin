-- message_queue: the cron hits this table on every tick (every minute).
-- These indexes eliminate the full-table scans that are depleting Disk IO.

-- Fetching pending/failed messages due now
CREATE INDEX IF NOT EXISTS idx_mq_status_scheduled
  ON public.message_queue(status, scheduled_at ASC);

-- Pacing queries: count today's sends + find last send (filter by status + sent_at)
CREATE INDEX IF NOT EXISTS idx_mq_status_sent_at
  ON public.message_queue(status, sent_at DESC);

-- JSONB step_order filter used in pacing queries
CREATE INDEX IF NOT EXISTS idx_mq_step_order
  ON public.message_queue((metadata->>'step_order'));

-- Per-contact lookups (dnd check, cancel pending, queue next step)
CREATE INDEX IF NOT EXISTS idx_mq_contact_id
  ON public.message_queue(contact_id);

-- Inbound push-notification scan (direction + push_notified)
CREATE INDEX IF NOT EXISTS idx_mq_inbound_unnotified
  ON public.message_queue(direction, push_notified)
  WHERE direction = 'inbound' AND push_notified = false;

-- contacts: pipeline filter in the cron's pacing join
CREATE INDEX IF NOT EXISTS idx_contacts_pipeline
  ON public.contacts(pipeline);

-- contact_sequences: status lookup on every processed message
CREATE INDEX IF NOT EXISTS idx_cs_contact_id
  ON public.contact_sequences(contact_id);

CREATE INDEX IF NOT EXISTS idx_cs_status
  ON public.contact_sequences(status);
