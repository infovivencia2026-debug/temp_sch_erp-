-- The faculty trim (0091) changed the role's SEED for schools provisioned
-- from here on; it never touched the permission rows a school already had
-- on file (owner, 2026-10-19: a Faculty login still showed Report cards
-- and Attendance after that shipped). role_permissions is not re-synced to
-- a changed seed automatically -- that only happens when a role is
-- explicitly (re)installed -- so every existing school's "faculty" row kept
-- the four permissions it was seeded with. Removed here, directly, for any
-- school that never hand-customised the role (is_default's own convention,
-- worker/src/routes/admin/users.ts installOptionalRole): a class teacher,
-- already carrying the Class Teacher role from 0091, is unaffected -- the
-- same four permissions sit on that role too.
-- Forward-only: once applied anywhere this file must not change.
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'faculty' AND customised_at IS NULL)
   AND permission_key IN ('academics.attendance.read', 'academics.attendance.write',
                           'academics.class360.view', 'academics.reportcards.generate');
