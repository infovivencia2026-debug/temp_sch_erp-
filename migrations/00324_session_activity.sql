-- +goose Up
/* What a login did, session by session.

   The principal's Logins screen could say that an account was signed in on
   three devices and end any of them; it could not say what any of those
   sessions had done. audit_log had every change but not which session made
   it, and nothing at all recorded which screens a session opened. Both are
   the question asked after the fact: "the fee counter was signed in at 9pm
   from a phone -- what did it touch?"

   Two additions. audit_log.session_id ties every recorded change to the
   session that made it. session_screens is one row per (session, screen)
   with a hit count and first/last time, fed by a beacon the SPA sends on
   each navigation -- coarse on purpose, a screen name and not a URL, so it
   answers "they opened Payroll" without keeping a click log. */

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS session_id uuid;
CREATE INDEX IF NOT EXISTS audit_log_session_idx ON audit_log (session_id, id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_screens (
    session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The feature key, e.g. finance.fee_counter; the catalogue names it.
    screen          text NOT NULL,
    first_at        timestamptz NOT NULL DEFAULT now(),
    last_at         timestamptz NOT NULL DEFAULT now(),
    hits            integer NOT NULL DEFAULT 1,
    PRIMARY KEY (session_id, screen)
);
CREATE INDEX IF NOT EXISTS session_screens_user_idx ON session_screens (user_id, last_at DESC);

ALTER TABLE session_screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_screens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_screens
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

COMMENT ON TABLE session_screens IS
    'Which screens a login session opened, one row per (session, screen) with a hit count. Fed by POST /api/v1/session/activity; read by the Logins screen per session.';

-- +goose Down
DROP TABLE IF EXISTS session_screens;
DROP INDEX IF EXISTS audit_log_session_idx;
ALTER TABLE audit_log DROP COLUMN IF EXISTS session_id;
