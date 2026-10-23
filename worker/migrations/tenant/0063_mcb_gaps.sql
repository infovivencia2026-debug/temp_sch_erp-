-- 0063_mcb_gaps (tenant: every school database).
--
-- Five things a school moving from MyClassBoard asked for by name and had
-- nowhere to put (docs/MCB_vs_XULO_comparison.pdf, section 4):
--
--   staff_tasks            office work handed to a member of staff, with a
--                          due date and a status, and the report over it.
--   fee_concessions        the signed paper behind a negotiated fee: a file
--                          and a note, kept beside the concession itself.
--   employees.reports_to   who a member of staff answers to, so a leave
--                          request can go to their manager first.
--   leave_requests.kind    a request is a leave, a compensatory off earned by
--                          working a holiday, or a permission (a few hours
--                          out). hours carries the permission's length.
--   reading levels         a title has a level; a child has a measured level
--                          per date, so the librarian can match the two.
--
-- Forward-only: once applied anywhere this file must not change.

CREATE TABLE IF NOT EXISTS staff_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  assigned_to TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_on TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  done_note TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS staff_tasks_assignee ON staff_tasks (institution_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS staff_tasks_due ON staff_tasks (institution_id, status, due_on);

ALTER TABLE fee_concessions ADD COLUMN attachment_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE fee_concessions ADD COLUMN document_note TEXT;

ALTER TABLE employees ADD COLUMN reports_to TEXT REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE leave_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'leave';
ALTER TABLE leave_requests ADD COLUMN hours REAL;

ALTER TABLE library_titles ADD COLUMN reading_level TEXT;

CREATE TABLE IF NOT EXISTS student_reading_levels (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  measured_on TEXT NOT NULL,
  note TEXT,
  measured_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS student_reading_levels_student ON student_reading_levels (institution_id, student_id, measured_on);
