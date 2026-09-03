-- +goose Up
-- The trustee's role is installed on request, like the warden's.
--
-- board_member arrived in Go (rbac.optionalRoles) and through `migrate seed`,
-- which already writes is_default from that list. This statement exists so
-- the migration history labels the role the same way 00016 labels the other
-- optional ones, and so the test that keeps Go and SQL honest can read it.
UPDATE roles SET is_default = false
 WHERE is_system AND key IN ('board_member');

-- +goose Down
UPDATE roles SET is_default = true
 WHERE is_system AND key IN ('board_member');
