-- +goose Up
-- user_roles_user_id_role_id_campus_id_key is UNIQUE over
-- (user_id, role_id, campus_id) and campus_id is nullable. An institution-wide
-- assignment has campus_id NULL, and because Postgres treats NULLs as distinct
-- the constraint never fires — so every ON CONFLICT DO NOTHING inserted another
-- copy. Re-running the seeder three times gave each demo user three identical
-- role rows.
--
-- Harmless to permissions (the grant set is a union either way) but it corrupts
-- any count of who holds a role, and it is about to matter a great deal: a
-- one-person school assigns every role to a single account, and that account's
-- role list must be exact.
--
-- Fourth occurrence of this pattern, after numbering_schemes (00004),
-- report_cards (00006) and announcement_acks (00007).

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

WITH ranked AS (
    SELECT id, row_number() OVER (
               PARTITION BY user_id, role_id,
                            COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid)
               ORDER BY created_at, id) AS rn
      FROM user_roles
)
DELETE FROM user_roles ur USING ranked r WHERE ur.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_institution_wide
    ON user_roles (user_id, role_id) WHERE campus_id IS NULL;

-- +goose Down
DROP INDEX IF EXISTS user_roles_institution_wide;
