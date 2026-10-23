-- A head of department is not the school's administrator (owner, 2026-10-19:
-- "for normal hod no need of logins and access and roles & permissions", and
-- "no need of attendance if they are not a class teacher").
--
-- These principal screens had reached the built-in HOD role, and the role
-- editor lists only a role's own workspace, so the school could not take them
-- off. Attendance marking goes too: a HOD who runs a class also holds Class
-- Teacher, which carries it.
-- Forward-only: once applied anywhere this file must not change.
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'hod' AND is_system = 1)
   AND permission_key IN ('institution_admin.staff.logins_access', 'institution_admin.staff.roles_permissions',
                          'institution_admin.staff.staff_groups_lists', 'academics.attendance.write');
