-- 0031_help_requests (tenant: every school database).
-- Help Centre requests ride on the ticket model that is already here.
--
-- support_tickets.audience gains a third value, 'helpdesk': a request for help
-- with the app, raised by a parent, a student or a member of staff and
-- answered by the school's own helpdesk. 'school' stays what it was (a
-- family's concern for the office) and 'vendor' stays the vendor's queue, so
-- every query that was written for those two reads exactly what it read.
-- A request the school cannot answer is escalated as a NEW vendor ticket that
-- carries only the summary the administrator confirmed (parent_ticket_id
-- points back; the family's words and the child stay in the school).
--
-- The rule Postgres held as a CHECK (migrations/00038_platform.sql) and the
-- D1 schema lost: a ticket naming a child can never be vendor-visible. SQLite
-- cannot add a CHECK to an existing table, so it is two triggers.
--
-- grievance_updates is the thread. A vendor agent is not one of this school's
-- users, so the author is also kept by name and by side.
--
-- Additive. Forward-only. No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE support_tickets ADD COLUMN origin TEXT;
ALTER TABLE support_tickets ADD COLUMN route TEXT;
ALTER TABLE support_tickets ADD COLUMN role_key TEXT;
ALTER TABLE support_tickets ADD COLUMN diagnostics TEXT;
ALTER TABLE support_tickets ADD COLUMN error_ref TEXT;
ALTER TABLE support_tickets ADD COLUMN parent_ticket_id TEXT;
ALTER TABLE support_tickets ADD COLUMN solved_by TEXT;
ALTER TABLE support_tickets ADD COLUMN me_too INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN merged_into TEXT;
ALTER TABLE support_tickets ADD COLUMN incident_id TEXT;
ALTER TABLE support_tickets ADD COLUMN last_reply_at TEXT;
ALTER TABLE support_tickets ADD COLUMN last_reply_side TEXT;

ALTER TABLE grievance_updates ADD COLUMN author_name TEXT;
ALTER TABLE grievance_updates ADD COLUMN author_side TEXT;

CREATE TABLE IF NOT EXISTS support_ticket_followers (
  ticket_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, user_id),
  FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS help_tip_dismissals (
  user_id TEXT NOT NULL,
  tip_key TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, tip_key),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Quick Assist: a support session the person on the other end agreed to, which may only read.
ALTER TABLE impersonation_grants ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE impersonation_grants ADD COLUMN consent_user_id TEXT;
ALTER TABLE impersonation_grants ADD COLUMN consent_user_name TEXT;

-- Tickets a school already raised with the vendor join the same model, so the desk and the school read one list.
UPDATE support_tickets SET origin = 'help' WHERE audience = 'vendor' AND origin IS NULL;

CREATE INDEX IF NOT EXISTS support_tickets_help_queue ON support_tickets (institution_id, status, created_at) WHERE (audience = 'helpdesk');
CREATE INDEX IF NOT EXISTS support_tickets_help_mine ON support_tickets (raised_by, created_at) WHERE (origin = 'help');
CREATE INDEX IF NOT EXISTS support_tickets_help_similar ON support_tickets (category, route, created_at) WHERE (origin = 'help');
CREATE INDEX IF NOT EXISTS support_tickets_parent ON support_tickets (parent_ticket_id) WHERE (parent_ticket_id IS NOT NULL);

CREATE TRIGGER IF NOT EXISTS support_tickets_vendor_no_child_i BEFORE INSERT ON support_tickets WHEN NEW.audience = 'vendor' AND NEW.student_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: support_tickets_vendor_never_names_a_child'); END;
CREATE TRIGGER IF NOT EXISTS support_tickets_vendor_no_child_u BEFORE UPDATE ON support_tickets WHEN NEW.audience = 'vendor' AND NEW.student_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: support_tickets_vendor_never_names_a_child'); END;
