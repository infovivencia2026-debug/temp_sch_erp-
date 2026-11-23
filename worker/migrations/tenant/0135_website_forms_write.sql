-- 0135_website_forms_write (tenant: every school database).
-- Editing website forms gets its own permission (owner, 2026-11-21): a staff
-- member can be given Edit on Website forms without every school setting.
-- The admin role keeps it, as it held the wider one.
--
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('comms.website_forms.write', 'comms', 'Create and change website forms');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.website_forms.write' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
