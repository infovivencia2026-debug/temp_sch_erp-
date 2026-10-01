-- 0023_request_path_indexes (tenant: every school database).
-- Indexes for the predicates every request runs (test/integration/perf.test.ts
-- counts them): the teaching scope (who teaches which section, which child is
-- whose), Class Status audiences, the student's LMS course and the principal's
-- board. Each one is a column a hot query filters or joins on that had no
-- index, so D1 scanned the table.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

-- resolveScope, every request: a teacher's sections from the timetable, a
-- child's own login, a head of department's departments.
CREATE INDEX IF NOT EXISTS timetable_entries_teacher ON timetable_entries (teacher_user_id, section_id);
CREATE INDEX IF NOT EXISTS students_user_id ON students (user_id);
CREATE INDEX IF NOT EXISTS departments_head ON departments (head_user_id);

-- module_settings is keyed (institution_id, module) but read by module alone
-- (one school per database): statusPolicy, student logins, every switch.
CREATE INDEX IF NOT EXISTS module_settings_module ON module_settings (module);

-- Class Status: who is in a class-wide audience; which teacher takes a section's subject.
CREATE INDEX IF NOT EXISTS enrollments_class_status ON enrollments (class_id, status);
CREATE INDEX IF NOT EXISTS section_subject_teachers_section ON section_subject_teachers (section_id, teacher_user_id);
CREATE INDEX IF NOT EXISTS status_posts_source ON status_posts (as_school, posted_by, status);

-- The student's course page and the teacher's: homework and tests by course,
-- a child's attempts at a test, a test's questions.
CREATE INDEX IF NOT EXISTS homework_section_subject ON homework (section_id, class_subject_id, is_published);
CREATE INDEX IF NOT EXISTS online_test_attempts_student ON online_test_attempts (test_id, student_id, status);
CREATE INDEX IF NOT EXISTS online_test_questions_test ON online_test_questions (test_id);
CREATE INDEX IF NOT EXISTS lms_lessons_section ON lms_lessons (section_id);

-- The bell: a person's entries by source (the one-per-poster Class Status entry).
CREATE INDEX IF NOT EXISTS notifications_user_source ON notifications (user_id, kind, source_kind, source_id);

-- The working year chooser and the HR reach: an employee by login.
CREATE INDEX IF NOT EXISTS employees_user_status ON employees (user_id, status);
