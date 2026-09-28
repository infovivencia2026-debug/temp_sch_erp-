-- 0008_lms_admin (tenant: every school database).
-- Lessons organised by day of the unit and published on a schedule, and the
-- optional "LMS Admin" role's catalogue entry. The role itself is installed
-- by a school from Roles & permissions (like the librarian); nothing here
-- creates it or grants it to anybody.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

-- Day 1, 2, 3 ... of the unit; NULL when the teacher does not plan by day.
ALTER TABLE lms_lessons ADD COLUMN day INTEGER;
-- Hidden from children until this moment (UTC ISO); NULL is at once.
ALTER TABLE lms_lessons ADD COLUMN publish_at TEXT;

INSERT OR IGNORE INTO permissions (key, module, description)
  VALUES ('lms_admin.lms.courses', 'lms_admin', 'Every course in the school: lessons, assignments and quizzes, for any subject and section.');
