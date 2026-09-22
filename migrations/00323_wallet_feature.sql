-- +goose Up
-- The Student wallets / Wallet screens get their catalog feature keys granted
-- to the roles that hold them, on tenants that already exist.
--
-- The menu shows a feature only when the role holds its feature key, and the
-- deploy runs `migrate up` alone -- never `migrate seed`, which would grant
-- these from the Go catalogue -- so, exactly as 00316 and 00321 did, this
-- migration carries the keys and their grants forward. The capability keys the
-- screens gate on (finance.wallet.*, self.wallet.read) went in with 00322;
-- these are the catalog keys that put the screens on the menu.
--
-- The catalog seeder files a feature key under the owning role's key as its
-- module (seedPermissions in cmd/migrate), so module matches the role.
-- permissions.key is the FK target of role_permissions.permission_key, so the
-- permission rows go in first. Roles are per-institution rows under forced
-- RLS, so platform standing is taken for this transaction first.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description) VALUES
    ('institution_admin.fees.student_wallets', 'institution_admin', 'Student wallets'),
    ('finance.fees.student_wallets',           'finance',           'Student wallets'),
    ('parent.fees.wallet',                     'parent',            'Wallet')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.key
  FROM roles r
  JOIN (VALUES
        ('institution_admin', 'institution_admin.fees.student_wallets'),
        ('finance',           'finance.fees.student_wallets'),
        ('parent',            'parent.fees.wallet')
       ) AS g(role_key, key) ON r.key = g.role_key
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';
DELETE FROM role_permissions
 WHERE permission_key IN ('institution_admin.fees.student_wallets',
                          'finance.fees.student_wallets',
                          'parent.fees.wallet');
