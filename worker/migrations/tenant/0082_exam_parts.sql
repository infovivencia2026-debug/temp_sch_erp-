-- Exams marked in parts (owner, 2026-10-13: "some schools give marks for
-- project assessment, notebook completion and overall performance, shown on
-- the report card; build it, but all should be editable"). An exam may list
-- parts -- Written 80, Project 10, Notebook 5, Overall 5 -- and every paper of
-- it is then marked per part. The paper's mark in marks stays the sum of its
-- parts and its max_marks the sum of the maxima, so report cards, results and
-- moderation read one total exactly as before. No parts: nothing changes.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS exam_parts (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  exam_id TEXT NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_marks REAL NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS exam_parts_exam ON exam_parts (exam_id, sequence);

CREATE TABLE IF NOT EXISTS mark_parts (
  institution_id TEXT NOT NULL,
  exam_subject_id TEXT NOT NULL REFERENCES exam_subjects (id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES exam_parts (id) ON DELETE CASCADE,
  marks REAL,
  updated_at TEXT,
  PRIMARY KEY (exam_subject_id, student_id, part_id)
);
CREATE INDEX IF NOT EXISTS mark_parts_part ON mark_parts (part_id);
