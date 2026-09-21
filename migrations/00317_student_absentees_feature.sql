-- +goose Up
-- The Student absentees monitoring screen gets its catalog feature keys granted
-- to the roles that already hold Absentee follow-up.
--
-- A new read-only screen watches the day's absentees and the follow-up state
-- live; it reads the same scoped endpoint the action screen does. The menu shows
-- a feature only when the role holds that feature key, and the deploy runs only
-- `migrate up` — not the role-grant half of `migrate seed`, which deletes and
-- rewrites every role's grants and would revert a school's own edits. So, as
-- 00314 and 00316 did before it, this migration carries the new keys and their
-- grants to schools that already exist.
--
-- Two keys, one screen: the faculty key is the teacher's Attendance section and
-- the institution_admin key is the principal's Academics section. permissions.key
-- is the FK target of role_permissions.permission_key, so the permission rows go
-- in first; the catalog seeder files a feature key's module as the owning role's
-- key (seedPermissions in cmd/migrate), so module matches the key's own role.
--
-- role_permissions is under forced row-level security and goose runs as the app
-- role, so platform standing is taken for this transaction first or the
-- INSERT ... SELECT over roles finds nothing to grant against.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description)
VALUES
  ('faculty.attendance.student_absentees', 'faculty',
   'Read-only live monitor of the day''s absentees and the follow-up state.'),
  ('institution_admin.academics.student_absentees', 'institution_admin',
   'Read-only live monitor of the day''s absentees and the follow-up state.')
ON CONFLICT (key) DO NOTHING;

-- The faculty key goes to the roles that hold faculty.attendance.absentee_followup
-- today: the teacher, and the class teacher (a merged persona granted the whole
-- teacher workspace).
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'faculty.attendance.student_absentees'
  FROM roles r
 WHERE r.key IN ('faculty', 'class_teacher')
ON CONFLICT DO NOTHING;

-- The institution_admin key goes to the principal and to the merged personas
-- that borrow the principal's Academics section (vice principal, head of
-- department) — the supervisors who watch follow-up across sections.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'institution_admin.academics.student_absentees'
  FROM roles r
 WHERE r.key IN ('institution_admin', 'vice_principal', 'hod')
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';

DELETE FROM role_permissions
 WHERE permission_key IN (
        'faculty.attendance.student_absentees',
        'institution_admin.academics.student_absentees');
