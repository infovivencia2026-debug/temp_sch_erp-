-- +goose Up

-- Migration 181 updated nothing, and said it had.
--
-- messaging_recipient_policy has FORCE ROW LEVEL SECURITY, which applies to
-- the table owner too. The migration runs with no app_current_institution()
-- set, so the policy matched no rows, the UPDATE touched none, and goose
-- recorded a clean success. The column default changed; the two rows that
-- actually decide whether mail leaves did not.
--
-- This is the same shape as the pg_dump that produced a 63 KB backup of a
-- 513 KB database and exited 0. A statement that is silently scoped to nothing
-- looks exactly like a statement that had nothing to do.
--
-- SET LOCAL app.is_platform_admin lifts the scope for this transaction, which
-- is the pattern migrations 162 and 173 already use for the same reason.

SET LOCAL app.is_platform_admin = 'on';

UPDATE messaging_recipient_policy
   SET mode = 'everyone',
       note = COALESCE(NULLIF(btrim(note), '') || ' | ', '')
              || 'Allowlist lifted; entries kept.',
       updated_at = now()
 WHERE mode = 'allowlist';

-- +goose Down

SET LOCAL app.is_platform_admin = 'on';

UPDATE messaging_recipient_policy SET mode = 'allowlist' WHERE mode = 'everyone';
