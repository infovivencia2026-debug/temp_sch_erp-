-- +goose Up
-- Revert the consolidated Attendance hub back into three separate menu tiles:
-- Take attendance, Present & absent (student_absentees) and Absentee follow-up,
-- each its own screen again.
--
-- 00318 folded the three attendance screens into one "Attendance" tile per
-- workspace, adding the combined keys faculty.attendance.attendance,
-- hod.attendance.attendance and institution_admin.academics.attendance and
-- granting them. This migration undoes that: it re-asserts the three separate
-- feature keys and their grants (idempotently, in case a school's own edits
-- touched them), then deletes the combined grants and the now-orphaned combined
-- permission rows so the merged tile disappears entirely.
--
-- The three separate keys predate the consolidation and were never revoked, so
-- on most schools these INSERTs are no-ops; they run here so the split state is
-- guaranteed even where a school edited its grants. As 00317/00318 did, the
-- permission rows go in first (permissions.key is the FK target of
-- role_permissions.permission_key), and the catalog seeder files a feature key's
-- module as the owning role's key.
--
-- role_permissions is under forced row-level security and goose runs as the app
-- role, so platform standing is taken for this transaction first or the
-- INSERT ... SELECT over roles finds nothing to grant against.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description)
VALUES
  ('faculty.attendance.take_attendance', 'faculty',
   'Fast daily or period/subject-wise attendance for assigned students.'),
  ('hod.attendance.take_attendance', 'hod',
   'Mark the register for the classes they teach.'),
  ('faculty.attendance.absentee_followup', 'faculty',
   'Call home to the families of the children marked away and record the reason.'),
  ('faculty.attendance.student_absentees', 'faculty',
   'Read-only live monitor of the day''s absentees and the follow-up state.'),
  ('institution_admin.academics.student_absentees', 'institution_admin',
   'Read-only live monitor of the day''s absentees and the follow-up state.')
ON CONFLICT (key) DO NOTHING;

-- Take attendance: faculty and class teacher on the faculty key, department head
-- on the hod key.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'faculty.attendance.take_attendance'
  FROM roles r
 WHERE r.key IN ('faculty', 'class_teacher')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'hod.attendance.take_attendance'
  FROM roles r
 WHERE r.key IN ('hod')
ON CONFLICT DO NOTHING;

-- Absentee follow-up: faculty and class teacher.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'faculty.attendance.absentee_followup'
  FROM roles r
 WHERE r.key IN ('faculty', 'class_teacher')
ON CONFLICT DO NOTHING;

-- Present & absent (student_absentees): faculty and class teacher on the faculty
-- key; principal, vice principal and head of department on the academics key.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'faculty.attendance.student_absentees'
  FROM roles r
 WHERE r.key IN ('faculty', 'class_teacher')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'institution_admin.academics.student_absentees'
  FROM roles r
 WHERE r.key IN ('institution_admin', 'vice_principal', 'hod')
ON CONFLICT DO NOTHING;

-- Drop the combined hub's grants and its now-orphaned permission rows.
DELETE FROM role_permissions
 WHERE permission_key IN (
        'faculty.attendance.attendance',
        'hod.attendance.attendance',
        'institution_admin.academics.attendance');

DELETE FROM permissions
 WHERE key IN (
        'faculty.attendance.attendance',
        'hod.attendance.attendance',
        'institution_admin.academics.attendance');

-- +goose Down
-- Restore the combined Attendance hub exactly as 00318 left it. The three
-- separate keys and their grants are left in place (they predate 00318), so the
-- down migration only re-adds the combined keys and their grants.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description)
VALUES
  ('faculty.attendance.attendance', 'faculty',
   'Attendance — one tile with Take, Present & absent and Follow-up tabs.'),
  ('hod.attendance.attendance', 'hod',
   'Attendance — one tile with Take, Present & absent and Follow-up tabs.'),
  ('institution_admin.academics.attendance', 'institution_admin',
   'Attendance — one tile with Take, Present & absent and Follow-up tabs.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'faculty.attendance.attendance'
  FROM roles r
 WHERE r.key IN ('faculty', 'class_teacher')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'hod.attendance.attendance'
  FROM roles r
 WHERE r.key IN ('hod')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'institution_admin.academics.attendance'
  FROM roles r
 WHERE r.key IN ('institution_admin', 'vice_principal', 'hod')
ON CONFLICT DO NOTHING;
