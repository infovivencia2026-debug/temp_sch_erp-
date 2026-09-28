-- 0006_concerns_pipeline (tenant: every school database).
-- The concerns pipeline, for families and for staff:
--   * support_tickets gains an attachment and a reopen count (the raiser may
--     reopen a resolved concern within a window).
--   * staff_grievances gains what the family side already had: SLA due times,
--     escalation, a rating, an attachment, and raiser_hash, a keyed hash of the
--     raiser's account so an anonymous raiser can follow their own concern
--     without the row naming them (raised_by and employee_id stay NULL).
--   * staff_grievance_updates is the staff side's timeline: internal notes and
--     replies the raiser sees (visible_to_raiser).
--
-- Additive only. Forward-only: once applied anywhere this file must not
-- change; fix a mistake with a new migration. No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE support_tickets ADD COLUMN attachment_file_id TEXT REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN reopened_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE staff_grievances ADD COLUMN raiser_hash TEXT;
ALTER TABLE staff_grievances ADD COLUMN attachment_file_id TEXT REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE staff_grievances ADD COLUMN respond_due_at TEXT;
ALTER TABLE staff_grievances ADD COLUMN resolve_due_at TEXT;
ALTER TABLE staff_grievances ADD COLUMN escalated_at TEXT;
ALTER TABLE staff_grievances ADD COLUMN escalated_to TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE staff_grievances ADD COLUMN satisfaction INTEGER;
ALTER TABLE staff_grievances ADD COLUMN satisfaction_note TEXT;
ALTER TABLE staff_grievances ADD COLUMN reopened_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS staff_grievances_raiser ON staff_grievances (raiser_hash) WHERE raiser_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS staff_grievance_updates (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  grievance_id TEXT NOT NULL REFERENCES staff_grievances (id) ON DELETE CASCADE,
  -- 'created' | 'note' | 'reply' | 'raiser_reply' | 'status' | 'assignment' | 'escalation' | 'resolution' | 'reopened' | 'rating'
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL,
  new_status TEXT,
  visible_to_raiser INTEGER NOT NULL DEFAULT 0,
  -- NULL for anything the anonymous raiser writes: their account is never stored.
  author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  from_raiser INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS staff_grievance_updates_case ON staff_grievance_updates (grievance_id, created_at);
