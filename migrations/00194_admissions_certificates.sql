-- +goose Up
-- The leaving paperwork, on the desk the family actually walks up to.
--
-- Issuing a transfer certificate lived only in the principal's workspace. The
-- dashboard told the admissions desk that a certificate was waiting to be
-- issued -- correctly, it is their job -- and the link pointed at a screen
-- their workspace does not contain, so the row rendered with nowhere to go.
--
-- The same screen is now a feature of the admissions workspace, and this
-- grants its key to the role that staffs that desk.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'admissions.applications.certificates_transfers'
  FROM roles r
 WHERE r.key = 'admissions'
ON CONFLICT DO NOTHING;

-- +goose Down
DELETE FROM role_permissions
 WHERE permission_key = 'admissions.applications.certificates_transfers';
