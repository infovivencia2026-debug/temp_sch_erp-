-- The LMS Admin's course list (owner, 2026-10-10): a course is a subject the
-- admin has added to a section, no longer every class subject x section.
-- layout is how the course is built: 'topic_day' (topics, each with days),
-- 'day' (days only) or 'topic' (topics only, no days).
-- Content (syllabus_units, lms_lessons, ...) is untouched; removing a course
-- from this list hides it from the admin's list and keeps everything in it.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS lms_courses (
  institution_id TEXT NOT NULL,
  section_id TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  class_subject_id TEXT NOT NULL REFERENCES class_subjects (id) ON DELETE CASCADE,
  layout TEXT NOT NULL DEFAULT 'topic_day' CHECK (layout IN ('topic_day', 'day', 'topic')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (section_id, class_subject_id)
);
