-- Re-enroll uncontacted free_website contacts into leads_incentive.
-- "Uncontacted" = contact_sequences.current_step = 0 (step 1 queued but never sent).

DO $$
DECLARE
  v_free_seq_id    uuid;
  v_leads_seq_id   uuid;
  v_step1          record;
  v_settings       record;
  v_contact_ids    uuid[];
  v_contact        record;
  v_cid            uuid;
  v_cs_id          uuid;
  v_msg_content    text;
  v_enrolled       int := 0;
  v_skipped_dnc    int := 0;
BEGIN
  SELECT id INTO v_free_seq_id  FROM sequences WHERE name = 'Outreach — Free Website Incentive';
  SELECT id INTO v_leads_seq_id FROM sequences WHERE name = 'Outreach — Leads Incentive';

  IF v_free_seq_id IS NULL  THEN RAISE EXCEPTION 'Free Website sequence not found'; END IF;
  IF v_leads_seq_id IS NULL THEN RAISE EXCEPTION 'Leads Incentive sequence not found'; END IF;

  SELECT * INTO v_step1 FROM sequence_steps
  WHERE sequence_id = v_leads_seq_id AND step_order = 1;

  SELECT * INTO v_settings FROM settings
  WHERE business_id = '79036fbb-997c-4f7b-b46f-ccc97a64c38d';

  -- Collect uncontacted contact IDs
  SELECT array_agg(cs.contact_id) INTO v_contact_ids
  FROM contact_sequences cs
  WHERE cs.sequence_id = v_free_seq_id
    AND cs.status      = 'active'
    AND cs.current_step = 0;

  IF v_contact_ids IS NULL THEN
    RAISE NOTICE 'No uncontacted free_website contacts found.';
    RETURN;
  END IF;

  RAISE NOTICE 'Found % uncontacted contacts.', array_length(v_contact_ids, 1);

  -- Stop old free_website sequences
  UPDATE contact_sequences
  SET status = 'stopped'
  WHERE sequence_id   = v_free_seq_id
    AND status        = 'active'
    AND current_step  = 0;

  -- Cancel any pending messages for these contacts
  UPDATE message_queue
  SET status = 'cancelled'
  WHERE contact_id = ANY(v_contact_ids)
    AND status     = 'pending';

  -- Enroll each contact into leads_incentive
  FOREACH v_cid IN ARRAY v_contact_ids
  LOOP
    SELECT id, full_name, phone, email, business_id
    INTO v_contact
    FROM contacts WHERE id = v_cid;

    -- Skip if no phone
    IF v_contact.phone IS NULL THEN CONTINUE; END IF;

    -- Skip if on DNC
    IF EXISTS (SELECT 1 FROM dnc_list WHERE phone = v_contact.phone) THEN
      v_skipped_dnc := v_skipped_dnc + 1;
      CONTINUE;
    END IF;

    -- Update contact
    UPDATE contacts
    SET outreach_angle    = 'leads_incentive',
        stage_entered_at  = now()
    WHERE id = v_cid;

    -- Create contact_sequence (idempotent)
    INSERT INTO contact_sequences (contact_id, sequence_id, current_step, status, started_at)
    VALUES (v_cid, v_leads_seq_id, 0, 'active', now())
    RETURNING id INTO v_cs_id;

    -- Resolve template (only {{my_name}} is used in step 1)
    v_msg_content := replace(
      v_step1.message_template,
      '{{my_name}}',
      coalesce(v_settings.my_name, '')
    );

    -- Queue step 1 immediately
    INSERT INTO message_queue (
      contact_id, contact_sequence_id, message_type, message_content,
      to_phone, scheduled_at, status, metadata
    ) VALUES (
      v_cid,
      v_cs_id,
      v_step1.message_type,
      v_msg_content,
      v_contact.phone,
      now(),
      'pending',
      jsonb_build_object('to', v_contact.phone, 'step_order', 1)
    );

    v_enrolled := v_enrolled + 1;
  END LOOP;

  RAISE NOTICE 'Done. Enrolled: %, Skipped DNC: %', v_enrolled, v_skipped_dnc;
END $$;
