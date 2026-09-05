-- +goose Up
-- A phone that can be told, rather than one that has to ask.
--
-- The alert feed is polled: the app fetches it, and the fetch is what
-- materialises circulars, absences, dues and homework into rows. A closed app
-- polls nothing, so a parent learned of a bus at their stop or a circular when
-- they next happened to open the portal. Push is the missing half: a device
-- token per installed app, and a mark on each notification saying it has been
-- handed to the phone.
CREATE TABLE push_tokens (
    token          text PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    platform       text NOT NULL DEFAULT 'android',
    app_version    text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_id_idx ON push_tokens (user_id);

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens FORCE  ROW LEVEL SECURITY;
CREATE POLICY push_tokens_tenant ON push_tokens
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON push_tokens TO app_user;

-- Set on every row the pump has considered, whether or not a phone was there
-- to receive it, so the partial index below only ever holds new work.
-- Existing rows are marked now: the day push arrives is not the day every
-- parent's phone gets a month of history.
ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
UPDATE notifications SET pushed_at = now() WHERE pushed_at IS NULL;
CREATE INDEX notifications_unpushed_idx ON notifications (created_at) WHERE pushed_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS notifications_unpushed_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS pushed_at;
DROP TABLE IF EXISTS push_tokens;
