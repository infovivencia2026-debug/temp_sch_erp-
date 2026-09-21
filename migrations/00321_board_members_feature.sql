-- +goose Up
-- The Board Members screen gets its catalog feature key granted to the vendor's
-- platform roles.
--
-- New endpoints let the seller/super admin assign a cross-institution board
-- member to several schools, and their screen is the catalog feature
-- seller_admin.support.board_members. The menu shows a feature only when the
-- role holds that feature key, and `migrate seed` (which would grant it from the
-- Go catalogue) is deliberately NOT run by the deploy — only `migrate up`. So,
-- exactly as 00316 did for the Support Team feature, this migration carries the
-- key and its grants to a platform that already exists.
--
-- permissions.key is the FK target of role_permissions.permission_key, so the
-- permission row goes in first. The catalog seeder files feature keys under the
-- owning role's key as their module (seedPermissions in cmd/migrate), so this
-- matches: module = 'seller_admin'.
--
-- The seller_admin and super_admin roles are platform roles with a NULL
-- institution, and both permissions and role_permissions are under forced RLS,
-- so platform standing is taken for this transaction first or the writes find
-- nothing to grant against.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description)
VALUES ('seller_admin.support.board_members', 'seller_admin',
        'Assign cross-institution board members to the schools they oversee.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'seller_admin.support.board_members'
  FROM roles r
 WHERE r.key IN ('seller_admin', 'super_admin')
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';

DELETE FROM role_permissions
 WHERE permission_key = 'seller_admin.support.board_members';
