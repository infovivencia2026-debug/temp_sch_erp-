-- 0006_sis_rbac: permissions for the student information system.
--
-- Note what parent and student get: nothing here except student.read. Their
-- access is not granted by role, it is derived from the student_guardians link
-- and the students.user_id column. A permission cannot express "only my own
-- children" — only a scope resolver can, and that lives in the service.

INSERT INTO permissions (key, domain, description, is_restricted) VALUES
    ('sis.student.read',            'sis', 'View students',                        false),
    ('sis.student.read_restricted', 'sis', 'View restricted student fields',       true),
    ('sis.student.create',          'sis', 'Admit a student',                      false),
    ('sis.student.update',          'sis', 'Update a student record',              false),
    ('sis.student.archive',         'sis', 'Archive a student record',             false),
    ('sis.student.export',          'sis', 'Export student data',                  true),
    ('sis.guardian.read',           'sis', 'View guardians',                       false),
    ('sis.guardian.manage',         'sis', 'Create and update guardians',          false),
    ('sis.guardian.link',           'sis', 'Link or unlink a guardian to a student', false),
    ('sis.enrollment.read',         'sis', 'View enrollments',                     false),
    ('sis.enrollment.manage',       'sis', 'Enrol and move students between sections', false),
    ('sis.lifecycle.manage',        'sis', 'Promote, transfer, withdraw students', false),
    ('academics.grade.read',        'academics', 'View classes',                   false),
    ('academics.grade.manage',      'academics', 'Create and update classes',      false),
    ('academics.section.read',      'academics', 'View sections',                  false),
    ('academics.section.manage',    'academics', 'Create and update sections',     false),
    ('academics.subject.read',      'academics', 'View subjects',                  false),
    ('academics.subject.manage',    'academics', 'Create and update subjects',     false),
    ('academics.allocation.read',   'academics', 'View teaching allocations',      false),
    ('academics.allocation.manage', 'academics', 'Assign teachers to sections',    false)
ON CONFLICT (key) DO UPDATE
    SET domain = excluded.domain,
        description = excluded.description,
        is_restricted = excluded.is_restricted;

-- A new system role: the class teacher, who owns a section end to end.
INSERT INTO roles (id, organization_id, key, name, description, is_system) VALUES
    (gen_random_uuid(), NULL, 'class_teacher', 'Class Teacher',
     'Owns a section: its students, attendance and remarks', true)
ON CONFLICT (key) WHERE organization_id IS NULL DO NOTHING;

-- org_admin and school_admin keep everything.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.organization_id IS NULL AND r.key = 'org_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.organization_id IS NULL AND r.key = 'school_admin'
  AND p.key <> 'platform.audit.read'
ON CONFLICT DO NOTHING;

-- principal: full visibility of their school and the lifecycle decisions that
-- are theirs to make. Restricted fields included — a principal handling a
-- medical emergency should not be blocked by a permission.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'sis.student.read', 'sis.student.read_restricted', 'sis.student.update',
    'sis.guardian.read', 'sis.enrollment.read', 'sis.enrollment.manage',
    'sis.lifecycle.manage',
    'academics.grade.read', 'academics.section.read', 'academics.subject.read',
    'academics.allocation.read', 'academics.allocation.manage'
]) AS k
WHERE r.organization_id IS NULL AND r.key = 'principal'
ON CONFLICT DO NOTHING;

-- class_teacher: their section's students and guardians, and nothing beyond.
-- The scope resolver, not this grant, is what limits them to their own section.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'tenancy.school.read', 'tenancy.year.read',
    'sis.student.read', 'sis.guardian.read', 'sis.enrollment.read',
    'academics.grade.read', 'academics.section.read', 'academics.subject.read',
    'academics.allocation.read'
]) AS k
WHERE r.organization_id IS NULL AND r.key = 'class_teacher'
ON CONFLICT DO NOTHING;

-- teacher: sees the students they teach. No guardian contact details — a
-- subject teacher does not need every parent's phone number.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'sis.student.read', 'sis.enrollment.read',
    'academics.grade.read', 'academics.section.read', 'academics.subject.read',
    'academics.allocation.read'
]) AS k
WHERE r.organization_id IS NULL AND r.key = 'teacher'
ON CONFLICT DO NOTHING;

-- accountant: needs to know who a student is to take a fee from them, and who
-- is financially responsible. No academic writes, ever.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'sis.student.read', 'sis.guardian.read', 'sis.enrollment.read',
    'academics.grade.read', 'academics.section.read'
]) AS k
WHERE r.organization_id IS NULL AND r.key = 'accountant'
ON CONFLICT DO NOTHING;

-- parent and student: read only, and only their own. The permission is the
-- floor; the scope resolver is the ceiling.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'sis.student.read', 'sis.enrollment.read', 'academics.section.read'
]) AS k
WHERE r.organization_id IS NULL AND r.key IN ('parent', 'student')
ON CONFLICT DO NOTHING;

-- The student role did not exist before this migration.
INSERT INTO roles (id, organization_id, key, name, description, is_system) VALUES
    (gen_random_uuid(), NULL, 'student', 'Student', 'Their own records only', true)
ON CONFLICT (key) WHERE organization_id IS NULL DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'sis.student.read', 'sis.enrollment.read', 'academics.section.read'
]) AS k
WHERE r.organization_id IS NULL AND r.key = 'student'
ON CONFLICT DO NOTHING;

-- auditor: reads everything, including restricted fields, and writes nothing.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.organization_id IS NULL AND r.key = 'auditor'
  AND (p.key LIKE '%.read' OR p.key LIKE '%.read_restricted' OR p.key = 'platform.audit.read')
ON CONFLICT DO NOTHING;
