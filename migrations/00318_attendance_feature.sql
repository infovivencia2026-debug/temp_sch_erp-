-- +goose Up
-- The consolidated Attendance screen gets its catalog feature keys granted to
-- the roles that already hold any of the three screens it replaces: Take
-- attendance, Absentee follow-up and the Present & absent monitor.
--
-- The three student-attendance screens are now one tile with a tab each (Take /
-- Present & absent / Follow-up), gated per tab by what the caller may do. The
-- menu shows a feature only when the role holds that feature key, and the deploy
-- runs only `migrate up` — not the role-grant half of `migrate seed`, which
-- deletes and rewrites every role's grants and would revert a school's own
-- edits. So, as 00314, 00316 and 00317 did before it, this migration carries the
-- new keys and their grants to schools that already exist.
--
-- Three keys, one screen: the faculty key is the teacher's Attendance section,
-- the hod key is the department head's own Attendance section, and the
-- institution_admin key is the principal's Academics section. permissions.key is
-- the FK target of role_permissions.permission_key, so the permission rows go in
-- first; the catalog seeder files a feature key's module as the owning role's key
-- (seedPermissions in cmd/migrate), so module matches the key's own role.
--
-- The OLD keys (…take_attendance, …absentee_followup, …student_absentees) are
-- deliberately NOT revoked. They are no longer catalog tiles, but their registry
-- mappings stay so deep links still resolve — Class 360's "Mark attendance"
-- button navigates to /go/take_attendance — and a stray grant on a key with no
-- menu tile is harmless.
--
-- role_permissions is under forced row-level security and goose runs as the app
-- role, so platform standing is taken for this transaction first or the
-- INSERT ... SELECT over roles finds nothing to grant against.
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

-- The faculty key goes to the roles that hold the faculty attendance keys today:
-- the teacher, and the class teacher (a merged persona granted the whole teacher
-- workspace).
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'faculty.attendance.attendance'
  FROM roles r
 WHERE r.key IN ('faculty', 'class_teacher')
ON CONFLICT DO NOTHING;

-- The hod key goes to the department head, whose own Attendance section held
-- Take attendance.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'hod.attendance.attendance'
  FROM roles r
 WHERE r.key IN ('hod')
ON CONFLICT DO NOTHING;

-- The institution_admin key goes to the principal and to the merged personas
-- that borrow the principal's Academics section (vice principal, head of
-- department) — the supervisors who watch attendance across sections.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'institution_admin.academics.attendance'
  FROM roles r
 WHERE r.key IN ('institution_admin', 'vice_principal', 'hod')
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';

DELETE FROM role_permissions
 WHERE permission_key IN (
        'faculty.attendance.attendance',
        'hod.attendance.attendance',
        'institution_admin.academics.attendance');
