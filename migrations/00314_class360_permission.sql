-- +goose Up
-- Class 360 gets a permission of its own.
--
-- The section-centric overview used to open on any of Students or Attendance
-- read, so a school could not grant or withhold it independently. rbac gained
-- academics.class360.view and the endpoint now gates on it. `migrate seed`
-- would install the key and re-grant it from the Go catalogue, but the deploy
-- runs only `migrate up` -- the role-grant half of seed is deliberately manual,
-- because it deletes and rewrites every role's grants and would revert a
-- school's own edits. So this migration is the one that carries the new key and
-- its grants to schools that already exist, matching how 00206 shipped the
-- seller's integrations key.
--
-- role_permissions is under forced row-level security and goose runs as the app
-- role, so the platform standing is taken for this transaction first; the
-- INSERT ... SELECT over roles finds nothing without it.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description)
VALUES ('academics.class360.view', 'academics', 'Open the Class 360 section overview')
ON CONFLICT (key) DO NOTHING;

-- Granted to the roles that hold it in the Go catalogue: the principal, the
-- academic leadership, department heads, teachers and the exam controller.
-- institution_admin is included here because on an existing tenant it is a
-- concrete role row, not a computed set -- keysExcept only shapes what a fresh
-- seed writes.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'academics.class360.view'
  FROM roles r
 WHERE r.key IN (
        'institution_admin', 'vice_principal', 'hod',
        'faculty', 'class_teacher', 'exam_controller')
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';

DELETE FROM role_permissions
 WHERE permission_key = 'academics.class360.view';
