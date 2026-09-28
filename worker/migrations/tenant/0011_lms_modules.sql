-- 0011_lms_modules (tenant: every school database).
-- The LMS laid out module first. A module is still a syllabus unit and a
-- source is still an lms_lessons row (new kinds image, audio and doc need no
-- schema: kind is free text checked in code). New here: a module's day or
-- date range, a source's length for the ones a file cannot tell (reading
-- time, an audio clip), an assignment or quiz placed in a module and ordered
-- among its sources, and when a child last opened a source ("new" and
-- "continue where you left off").
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE syllabus_units ADD COLUMN starts_on TEXT;
ALTER TABLE syllabus_units ADD COLUMN ends_on TEXT;

-- Minutes, as the teacher gives it; NULL when unknown or read from the file.
ALTER TABLE lms_lessons ADD COLUMN duration_minutes INTEGER;

-- An assignment or quiz inside a module, and its place among the sources.
ALTER TABLE homework ADD COLUMN lms_unit_id TEXT REFERENCES syllabus_units (id) ON DELETE SET NULL;
ALTER TABLE homework ADD COLUMN lms_sequence INTEGER;
ALTER TABLE online_tests ADD COLUMN lms_unit_id TEXT REFERENCES syllabus_units (id) ON DELETE SET NULL;
ALTER TABLE online_tests ADD COLUMN lms_sequence INTEGER;
CREATE INDEX IF NOT EXISTS homework_lms_unit ON homework (lms_unit_id) WHERE lms_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS online_tests_lms_unit ON online_tests (lms_unit_id) WHERE lms_unit_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lms_lesson_views (
  institution_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lms_lessons (id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  first_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS lms_lesson_views_student ON lms_lesson_views (student_id, last_at);
