-- +goose Up
-- The parent's Timetable and Update my details screens reach families that
-- already exist.
--
-- Two catalog feature keys put the screens on the menu, and one capability
-- key (academics.timetable.read, which the parent role now carries in
-- internal/rbac) lets the timetable endpoint answer. The deploy runs
-- `migrate up` alone -- never `migrate seed` -- so, as 00316 and 00323 did,
-- this migration carries the keys and their grants forward. Roles are
-- per-institution rows under forced RLS, so platform standing is taken first.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description) VALUES
    ('parent.academics.timetable',        'parent', 'Timetable'),
    ('parent.profile.update_my_details',  'parent', 'Update my details')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.key
  FROM roles r
  JOIN (VALUES
        ('parent', 'parent.academics.timetable'),
        ('parent', 'parent.profile.update_my_details'),
        ('parent', 'academics.timetable.read')
       ) AS g(role_key, key) ON r.key = g.role_key
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';
DELETE FROM role_permissions
 WHERE permission_key IN ('parent.academics.timetable',
                          'parent.profile.update_my_details')
    OR (permission_key = 'academics.timetable.read'
        AND role_id IN (SELECT id FROM roles WHERE key = 'parent'));
