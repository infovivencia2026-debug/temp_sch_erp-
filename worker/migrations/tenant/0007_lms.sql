-- 0007_lms (tenant: every school database).
-- The learning management layer over what the school already records:
-- units are syllabus_units (per class subject), assignments are homework and
-- homework_submissions, quizzes are online_tests over question_bank_questions.
-- New here: the lessons inside a unit, which lessons a child has finished,
-- a rubric on an assignment and the scores against it, and when marked work
-- was handed back to the child.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS lms_lessons (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES syllabus_units (id) ON DELETE CASCADE,
  -- NULL: every section of the class; otherwise only this section sees it.
  section_id TEXT REFERENCES sections (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- text | file | pdf | video | link
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  file_id TEXT REFERENCES files (id) ON DELETE SET NULL,
  url TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS lms_lessons_unit ON lms_lessons (unit_id, sequence);

CREATE TABLE IF NOT EXISTS lms_lesson_progress (
  institution_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lms_lessons (id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS lms_lesson_progress_student ON lms_lesson_progress (student_id);

-- [{"criterion": "Accuracy", "max": 5}, ...]; NULL when the work is marked as a single number.
ALTER TABLE homework ADD COLUMN rubric TEXT;
-- {"Accuracy": 4, ...} against homework.rubric.
ALTER TABLE homework_submissions ADD COLUMN rubric_scores TEXT;
-- Set when the teacher hands marked work back; the child sees marks and comments from then on.
ALTER TABLE homework_submissions ADD COLUMN returned_at TEXT;
