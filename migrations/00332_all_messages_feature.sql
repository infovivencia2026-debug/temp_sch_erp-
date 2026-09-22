-- +goose Up
-- The principal's All messages desk reaches schools that already exist.
-- Same shape as 00323 / 00330: the deploy runs `migrate up`, never `seed`,
-- so the catalog key and its grant are carried here.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description) VALUES
    ('institution_admin.communication.all_messages', 'institution_admin', 'All messages')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'institution_admin.communication.all_messages'
  FROM roles r
 WHERE r.key = 'institution_admin'
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';
DELETE FROM role_permissions
 WHERE permission_key = 'institution_admin.communication.all_messages';
