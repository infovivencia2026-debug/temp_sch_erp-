-- 0022_front_office_status (tenant: every school database).
-- The front office posts as the school in Class Status: the receptionist is
-- who actually puts the school's own notices up, so the built-in
-- front_office role gets status.post_school, and status.post with it (the
-- roles grid's view rung for the group; internal/rbac/model.go). A school
-- that customised the role keeps its customisation, as in 0020.
--
-- Forward-only. Re-runnable (INSERT OR IGNORE). No BEGIN/COMMIT (D1 rejects them).

INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'status.post' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'status.post_school' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
