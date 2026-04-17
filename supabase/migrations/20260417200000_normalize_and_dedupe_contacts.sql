-- Normalize contact phone numbers to E.164 format, dedupe, and enforce uniqueness.
-- Why: multiple code paths create contacts (inbound-sms, flow-call-booked, chat widget, etc.)
-- without a canonical phone format or dedup, causing the same person to appear as many rows
-- with differently-formatted phones ("+12092435062", "2092435062", "+1 (209) 243-5062").
-- This breaks inbound-sms contact match, flow-ob-form-submitted auto-match, and CRM timelines.

BEGIN;

-- ============================================================================
-- 0. DROP ANY PRE-EXISTING UNIQUE CONSTRAINT/INDEX ON (phone, business_id)
-- ============================================================================
-- An older constraint (without NULLS NOT DISTINCT) already existed in Supabase.
-- We drop it so the normalize step below doesn't fail when it merges format
-- variants ("+1 (209) 243-5062" → "+12092435062") that collide with already-
-- normalized rows. A new constraint with stricter semantics is recreated at
-- the end of this migration.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_business_id_unique;
DROP INDEX IF EXISTS contacts_phone_business_id_unique;

-- ============================================================================
-- 1. NORMALIZE PHONE FORMAT TO E.164
-- ============================================================================

-- "Anonymous" sentinel (from chat widget when phone unknown) → NULL
UPDATE contacts SET phone = NULL WHERE phone = 'Anonymous';

-- Empty strings → NULL
UPDATE contacts SET phone = NULL WHERE phone = '';

-- Strip formatting, then:
--  10 digits → assume US/CA, prepend "+1"
--  11+ digits → prepend "+" (either already has country code or international)
--  <10 digits → NULL (can't normalize — probably garbage)
UPDATE contacts
SET phone = CASE
  WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
    THEN '+1' || regexp_replace(phone, '[^0-9]', '', 'g')
  WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 11
    THEN '+' || regexp_replace(phone, '[^0-9]', '', 'g')
  ELSE NULL
END
WHERE phone IS NOT NULL;

-- ============================================================================
-- 2. DEDUPE: merge rows with same (business_id, phone)
-- ============================================================================
-- For each group, keep the row with the most recent updated_at (tiebreak: created_at).
-- Move FK references from losers to keepers, then delete losers.

CREATE TEMP TABLE contact_dedupe_map AS
WITH ranked AS (
  SELECT
    id,
    business_id,
    phone,
    updated_at,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(business_id::text, '__null__'), phone
      ORDER BY updated_at DESC, created_at DESC
    ) AS rn
  FROM contacts
  WHERE phone IS NOT NULL
)
SELECT
  loser.id AS loser_id,
  keeper.id AS keeper_id
FROM ranked loser
JOIN ranked keeper
  ON COALESCE(loser.business_id::text, '__null__') = COALESCE(keeper.business_id::text, '__null__')
 AND loser.phone = keeper.phone
 AND keeper.rn = 1
WHERE loser.rn > 1;

-- Reassign FK references from loser contacts to keeper contacts.
-- (Add any other FK tables here if the schema grows.)
UPDATE message_queue
  SET contact_id = m.keeper_id
  FROM contact_dedupe_map m
  WHERE message_queue.contact_id = m.loser_id;

UPDATE automation_logs
  SET contact_id = m.keeper_id
  FROM contact_dedupe_map m
  WHERE automation_logs.contact_id = m.loser_id;

UPDATE activity_log
  SET contact_id = m.keeper_id
  FROM contact_dedupe_map m
  WHERE activity_log.contact_id = m.loser_id;

UPDATE contact_sequences
  SET contact_id = m.keeper_id
  FROM contact_dedupe_map m
  WHERE contact_sequences.contact_id = m.loser_id;

UPDATE onboarding_submissions
  SET contact_id = m.keeper_id
  FROM contact_dedupe_map m
  WHERE onboarding_submissions.contact_id = m.loser_id;

-- Delete the loser rows.
DELETE FROM contacts
  WHERE id IN (SELECT loser_id FROM contact_dedupe_map);

DROP TABLE contact_dedupe_map;

-- ============================================================================
-- 3. ENFORCE UNIQUENESS on (business_id, phone)
-- ============================================================================
-- Partial unique index so NULL phones are allowed for many contacts.
-- NULLS NOT DISTINCT (Postgres 15+) so two contacts with NULL business_id
-- but the same phone are still considered duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_business_id_unique
  ON contacts (business_id, phone)
  NULLS NOT DISTINCT
  WHERE phone IS NOT NULL;

COMMIT;
