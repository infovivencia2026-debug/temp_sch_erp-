-- 0018_query_indexes (tenant: every school database).
-- Indexes for the predicates the Worker actually runs. The baseline copied
-- Postgres's indexes, most of which start with institution_id; D1 queries do
-- not filter on it (the database is the school), so SQLite could not use them
-- and scanned whole tables. Found with EXPLAIN QUERY PLAN over every SQL
-- string in worker/src (see docs/d1-health.md, "Index audit").
--
-- Also: ref_versions, a version number the reference-data cache
-- (src/services/refcache.ts) keys on. Triggers bump it on any write to
-- classes, sections, subjects, academic_years and user_working_years.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

-- Attendance: a student's history, date ranges across the school.
CREATE INDEX IF NOT EXISTS student_attendance_student_date ON student_attendance (student_id, on_date, status);
CREATE INDEX IF NOT EXISTS student_attendance_date_status ON student_attendance (on_date, status);
CREATE INDEX IF NOT EXISTS staff_attendance_date_status ON staff_attendance (on_date, status);
CREATE INDEX IF NOT EXISTS staff_attendance_user_date ON staff_attendance (user_id, on_date);

-- Students and their enrolments.
CREATE INDEX IF NOT EXISTS students_status ON students (status);
CREATE INDEX IF NOT EXISTS students_admission_date ON students (admission_date);
CREATE INDEX IF NOT EXISTS enrollments_student_enrolled ON enrollments (student_id, enrolled_on);
CREATE INDEX IF NOT EXISTS enrollments_year_section ON enrollments (academic_year_id, section_id);

-- Fees: collections by day, dues, failed payments.
CREATE INDEX IF NOT EXISTS payments_status_paid_on ON payments (status, paid_on);
CREATE INDEX IF NOT EXISTS payments_status_created ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS invoices_status_due ON invoices (status, due_on);
CREATE INDEX IF NOT EXISTS invoices_issued_on ON invoices (issued_on);
CREATE INDEX IF NOT EXISTS fee_structures_year_class ON fee_structures (academic_year_id, class_id);
CREATE INDEX IF NOT EXISTS student_fee_components_student_year ON student_fee_components (student_id, academic_year_id);

-- Admissions pipeline and the principal's brief.
CREATE INDEX IF NOT EXISTS applications_enquiry ON applications (enquiry_id, created_at);
CREATE INDEX IF NOT EXISTS applications_created ON applications (created_at);
CREATE INDEX IF NOT EXISTS applications_status_decided ON applications (status, decided_at);
CREATE INDEX IF NOT EXISTS applications_application_no ON applications (application_no);

-- Staff, leave, the attention list.
CREATE INDEX IF NOT EXISTS employees_status_department ON employees (status, department_id);
CREATE INDEX IF NOT EXISTS employees_department ON employees (department_id);
CREATE INDEX IF NOT EXISTS employees_joined_on ON employees (joined_on);
CREATE INDEX IF NOT EXISTS leave_requests_status_kind ON leave_requests (status, subject_kind, from_date);
CREATE INDEX IF NOT EXISTS leave_requests_type ON leave_requests (leave_type_id);

-- Timetable, exams, report cards.
CREATE INDEX IF NOT EXISTS timetable_entries_year_section ON timetable_entries (academic_year_id, section_id);
CREATE INDEX IF NOT EXISTS timetable_entries_class_subject ON timetable_entries (class_subject_id);
CREATE INDEX IF NOT EXISTS sections_class_year ON sections (class_id, academic_year_id);
CREATE INDEX IF NOT EXISTS sections_year ON sections (academic_year_id);
CREATE INDEX IF NOT EXISTS exam_subjects_exam ON exam_subjects (exam_id);
CREATE INDEX IF NOT EXISTS exam_subjects_class_subject ON exam_subjects (class_subject_id);
CREATE INDEX IF NOT EXISTS report_cards_student_year ON report_cards (student_id, academic_year_id);
CREATE INDEX IF NOT EXISTS report_cards_remarks_by ON report_cards (class_teacher_remarks_by, class_teacher_remarks_at) WHERE class_teacher_remarks_by IS NOT NULL;

-- LMS and homework.
CREATE INDEX IF NOT EXISTS lms_lessons_video ON lms_lessons (video_id) WHERE video_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lms_video_progress_video ON lms_video_progress (video_id);
CREATE INDEX IF NOT EXISTS homework_submissions_homework ON homework_submissions (homework_id, student_id);
CREATE INDEX IF NOT EXISTS homework_submissions_file ON homework_submissions (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS homework_attachments_file ON homework_attachments (file_id);
CREATE INDEX IF NOT EXISTS online_tests_section_subject ON online_tests (section_id, class_subject_id, status);

-- Notices, messages, notifications, logs.
CREATE INDEX IF NOT EXISTS announcements_publish_at ON announcements (publish_at);
CREATE INDEX IF NOT EXISTS announcements_created_by ON announcements (created_by);
CREATE INDEX IF NOT EXISTS message_log_queued_at ON message_log (queued_at);
CREATE INDEX IF NOT EXISTS message_log_channel_queued ON message_log (channel, queued_at);
CREATE INDEX IF NOT EXISTS notifications_source ON notifications (source_kind, source_id) WHERE source_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS login_events_created_at ON login_events (created_at);
CREATE INDEX IF NOT EXISTS library_loans_issued_on ON library_loans (issued_on);
CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions (created_at);

-- The reference-data version (services/refcache.ts).
CREATE TABLE IF NOT EXISTS ref_versions (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO ref_versions (key, version) VALUES ('ref', 1);
CREATE TRIGGER IF NOT EXISTS ref_bump_classes_i AFTER INSERT ON classes BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_classes_u AFTER UPDATE ON classes BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_classes_d AFTER DELETE ON classes BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_sections_i AFTER INSERT ON sections BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_sections_u AFTER UPDATE ON sections BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_sections_d AFTER DELETE ON sections BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_subjects_i AFTER INSERT ON subjects BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_subjects_u AFTER UPDATE ON subjects BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_subjects_d AFTER DELETE ON subjects BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_years_i AFTER INSERT ON academic_years BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_years_u AFTER UPDATE ON academic_years BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_years_d AFTER DELETE ON academic_years BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_uwy_i AFTER INSERT ON user_working_years BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_uwy_u AFTER UPDATE ON user_working_years BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
CREATE TRIGGER IF NOT EXISTS ref_bump_uwy_d AFTER DELETE ON user_working_years BEGIN UPDATE ref_versions SET version = version + 1 WHERE key = 'ref'; END;
