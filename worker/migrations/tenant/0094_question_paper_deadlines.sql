-- Who was asked to send a question paper, and by when (owner, 2026-10-19:
-- "examination branch will set a deadline... all the subject teachers... get
-- a deadline in dashboard and in notification... if it is sent within time it
-- is okay or else this will be a remark in their performance").
--
-- Submission itself stays exactly where it already was (question_papers,
-- one row per exam_subject, ON CONFLICT upsert) -- this table only records
-- who was asked and when they were due, so lateness can be read off the two
-- tables together rather than duplicating the paper. manually_received_at is
-- the examination branch's own "it came some other way, mark it given".
-- remarked_at guards the once-only staff_remarks row a missed deadline writes.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS question_paper_deadlines (
  id TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  exam_subject_id TEXT NOT NULL REFERENCES exam_subjects (id) ON DELETE CASCADE,
  teacher_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  deadline TEXT NOT NULL,
  scheduled_by TEXT NOT NULL REFERENCES users (id),
  manually_received_at TEXT,
  remarked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (id),
  UNIQUE (exam_subject_id, teacher_user_id)
);
CREATE INDEX IF NOT EXISTS question_paper_deadlines_sweep_idx ON question_paper_deadlines (deadline) WHERE remarked_at IS NULL;
