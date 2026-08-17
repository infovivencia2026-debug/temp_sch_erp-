-- 0004_rbac_catalogue: the permission catalogue and the system roles.
--
-- Reference data, so it belongs in a migration rather than the seeder: the
-- application's authorization checks are meaningless without it, in every
-- environment. Demo organizations and users come from `cmd/api seed`.
--
-- Phase 1 registers the platform and tenancy permissions only. Each later phase
-- adds its own domain's rows here as it lands.

INSERT INTO permissions (key, domain, description, is_restricted) VALUES
    ('platform.user.read',       'platform', 'View users',                    false),
    ('platform.user.create',     'platform', 'Create users',                  false),
    ('platform.user.update',     'platform', 'Update users',                  false),
    ('platform.role.read',       'platform', 'View roles and permissions',    false),
    ('platform.role.assign',     'platform', 'Assign roles to users',         false),
    ('platform.audit.read',      'platform', 'Read the audit log',            true),
    ('platform.settings.read',   'platform', 'View settings',                 false),
    ('platform.settings.update', 'platform', 'Change settings',               false),
    ('tenancy.school.read',      'tenancy',  'View schools',                  false),
    ('tenancy.school.create',    'tenancy',  'Create a school',               false),
    ('tenancy.school.update',    'tenancy',  'Update a school',               false),
    ('tenancy.school.archive',   'tenancy',  'Archive a school',              false),
    ('tenancy.campus.read',      'tenancy',  'View campuses',                 false),
    ('tenancy.campus.manage',    'tenancy',  'Create and update campuses',    false),
    ('tenancy.year.read',        'tenancy',  'View academic years',           false),
    ('tenancy.year.manage',      'tenancy',  'Create and update academic years', false)
ON CONFLICT (key) DO UPDATE
    SET domain = excluded.domain,
        description = excluded.description,
        is_restricted = excluded.is_restricted;

INSERT INTO roles (id, organization_id, key, name, description, is_system) VALUES
    (gen_random_uuid(), NULL, 'org_admin',     'Organisation Admin', 'All schools in the organisation', true),
    (gen_random_uuid(), NULL, 'school_admin',  'School Admin',       'Everything within one school', true),
    (gen_random_uuid(), NULL, 'principal',     'Principal',          'Full read and approvals for a school', true),
    (gen_random_uuid(), NULL, 'teacher',       'Teacher',            'Own allocations only', true),
    (gen_random_uuid(), NULL, 'accountant',    'Accountant',         'Finance only, no academic writes', true),
    (gen_random_uuid(), NULL, 'parent',        'Parent',             'Own children only', true),
    (gen_random_uuid(), NULL, 'auditor',       'Auditor',            'Read-only everything, writes nothing', true)
ON CONFLICT (key) WHERE organization_id IS NULL DO NOTHING;

-- org_admin: everything registered so far.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.key = 'org_admin' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- school_admin: everything except reading the audit log.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.key = 'school_admin' AND r.organization_id IS NULL
  AND p.key <> 'platform.audit.read'
ON CONFLICT DO NOTHING;

-- principal: full read of their school, plus audit visibility. No school CRUD.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'tenancy.school.read', 'tenancy.campus.read', 'tenancy.year.read',
    'platform.user.read', 'platform.role.read', 'platform.audit.read',
    'platform.settings.read'
]) AS k
WHERE r.key = 'principal' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- teacher: needs to see the school they teach in. Nothing else here yet.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'tenancy.school.read', 'tenancy.year.read'
]) AS k
WHERE r.key = 'teacher' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- accountant: reads the school for context. Zero academic or tenancy writes.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'tenancy.school.read', 'tenancy.year.read'
]) AS k
WHERE r.key = 'accountant' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- parent: no tenancy permissions at all. A parent's access comes entirely from
-- their children's records, which arrive in Phase 5.

-- auditor: reads everything, writes nothing.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.key = 'auditor' AND r.organization_id IS NULL
  AND (p.key LIKE '%.read' OR p.key = 'platform.audit.read')
ON CONFLICT DO NOTHING;
