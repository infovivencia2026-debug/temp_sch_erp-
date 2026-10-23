-- A head for each subject (owner, 2026-10-16: "different subject hod for
-- different persons ... see all their subject teachers from grade 1").
-- One person can head several subjects; a subject has at most one head.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS subject_heads (
  subject_id TEXT NOT NULL PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL,
  head_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS subject_heads_head ON subject_heads (head_user_id);

-- Meetings a subject head calls with that subject's teachers.
CREATE TABLE IF NOT EXISTS subject_meetings (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  agenda TEXT,
  meets_at TEXT NOT NULL,
  place TEXT,
  minutes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS subject_meetings_subject ON subject_meetings (subject_id, meets_at);
