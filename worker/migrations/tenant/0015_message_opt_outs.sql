-- 0015_message_opt_outs (tenant: every school database).
-- Messaging hardening (docs/audit-2026-09-23.md Tier 3):
--   * opt-out per contact (a phone or an address), not per enquiry row, and
--     honoured by every marketing send; a STOP reply lands here too;
--   * SMS segment count per message, so cost follows what the carrier bills.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

-- contact: 'phone:<E.164 digits>' or 'email:<lowercased address>' (msg_guard normaliseRecipient).
-- scope: 'marketing' (campaigns, admissions nurture) or 'all' (everything but
-- one-time codes and emergencies).
CREATE TABLE IF NOT EXISTS message_opt_outs (
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  contact TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'marketing',
  source TEXT NOT NULL DEFAULT 'office',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (institution_id, contact, scope)
);
CREATE INDEX IF NOT EXISTS message_opt_outs_contact ON message_opt_outs (contact);

ALTER TABLE message_log ADD COLUMN segments INTEGER;
ALTER TABLE message_log ADD COLUMN encoding TEXT;
