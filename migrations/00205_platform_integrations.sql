-- +goose Up
-- A messaging provider that belongs to the seller rather than to a school.
--
-- Every integrations row was a school's, and the seller -- the platform's
-- own staff, who belong to no institution -- had nowhere to keep a mail
-- server or an SMS channel of their own. Password-reset links were queued
-- against the account's school and went out only if that school had
-- configured email, which most never do; the reset page then told the person
-- to telephone the office, which is the thing it exists to prevent.
--
-- institution_id NULL is the platform, the same convention roles already
-- uses. One row per provider at that level.
ALTER TABLE integrations ALTER COLUMN institution_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS integrations_platform_provider_key
    ON integrations (provider) WHERE institution_id IS NULL;

-- +goose Down
DELETE FROM integrations WHERE institution_id IS NULL;
DROP INDEX IF EXISTS integrations_platform_provider_key;
ALTER TABLE integrations ALTER COLUMN institution_id SET NOT NULL;
