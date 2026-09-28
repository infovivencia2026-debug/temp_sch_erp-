-- 0012_lms_progression (tenant: every school database).
-- The LMS as Course > Module (sub-modules allowed) > Day > four sections
-- (Pre-requisites, Resources, Tools, Assessment), taken one by one: a day
-- opens when the one before it is finished (every required source done and
-- the assessment handed in, or passed when the teacher set a pass mark),
-- unless the course is switched to "Open". Days already exist as
-- lms_lessons.day (0008); here they get labels, and assignments and quizzes
-- get a day and a pass mark.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

-- A sub-module sits inside a module (one level).
ALTER TABLE syllabus_units ADD COLUMN parent_unit_id TEXT REFERENCES syllabus_units (id) ON DELETE SET NULL;

-- 'prereq' | 'resources' | 'tools' | 'assessment'; NULL reads as 'resources'.
ALTER TABLE lms_lessons ADD COLUMN section TEXT;
-- An optional source does not hold the next day back.
ALTER TABLE lms_lessons ADD COLUMN is_optional INTEGER NOT NULL DEFAULT 0;

-- An assignment or quiz on a day of its module, and the percentage that passes it (NULL: handing in is enough).
ALTER TABLE homework ADD COLUMN lms_day INTEGER;
ALTER TABLE homework ADD COLUMN lms_pass_percent INTEGER;
ALTER TABLE online_tests ADD COLUMN lms_day INTEGER;
ALTER TABLE online_tests ADD COLUMN lms_pass_percent INTEGER;

-- The days of a module that exist before anything is put on them, and their names ("Day 3: Fractions on a line").
CREATE TABLE IF NOT EXISTS lms_unit_days (
  institution_id TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES syllabus_units (id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (unit_id, day)
);

-- Per course (a subject in a section): 'sequential' (one by one, the default when there is no row) or 'open'.
CREATE TABLE IF NOT EXISTS lms_course_settings (
  institution_id TEXT NOT NULL,
  section_id TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  class_subject_id TEXT NOT NULL REFERENCES class_subjects (id) ON DELETE CASCADE,
  gating TEXT NOT NULL DEFAULT 'sequential',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (section_id, class_subject_id)
);

-- A teacher opening one day early for one child (day 0: the part of the module with no day).
CREATE TABLE IF NOT EXISTS lms_unlocks (
  institution_id TEXT NOT NULL,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES syllabus_units (id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  granted_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (student_id, unit_id, day)
);
