-- +goose Up
-- A permission granted to one account, on top of what its roles give.
--
-- Permissions have always been a union across a user's roles, and for the
-- shapes a school actually has that is enough: one person, several roles. But
-- now and then a single account needs one extra key that no role it holds
-- carries, and the alternative today is to invent a whole role for one grant or
-- to widen a shared role and hand the key to everyone in it. This table is the
-- narrow answer: a direct, per-account grant, unioned into the session
-- alongside the role-based keys, never replacing them.
CREATE TABLE user_permissions (
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    permission_key text NOT NULL,
    granted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, permission_key)
);
CREATE INDEX user_permissions_user_id_idx ON user_permissions (user_id);

ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_permissions_tenant ON user_permissions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_permissions TO app_user;

-- +goose Down
DROP TABLE IF EXISTS user_permissions;
