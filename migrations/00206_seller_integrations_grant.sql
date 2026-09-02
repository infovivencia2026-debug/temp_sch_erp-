-- +goose Up
-- The seller's grant to its own delivery channels.
--
-- 00205 gave the seller somewhere to keep a mail server and an SMS channel;
-- the Go role definition gained institution.integrations.write to reach
-- them. But `migrate seed` deliberately leaves an existing role's capability
-- grants alone -- rewriting them on every deploy would revert any role a
-- school edited in the permissions grid -- so on an installation that
-- already had a seller_admin row the key never arrived, and the new screen
-- answered 403. This is the one row the seed would have written.
INSERT INTO permissions (key, module, description)
VALUES ('institution.integrations.write', 'institution', 'Configure integrations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'institution.integrations.write'
  FROM roles r
 WHERE r.key = 'seller_admin' AND r.institution_id IS NULL
   AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_key = 'institution.integrations.write');

-- +goose Down
DELETE FROM role_permissions rp
 USING roles r
 WHERE rp.role_id = r.id AND r.key = 'seller_admin' AND r.institution_id IS NULL
   AND rp.permission_key = 'institution.integrations.write';
