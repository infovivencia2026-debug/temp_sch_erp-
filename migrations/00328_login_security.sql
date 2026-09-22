-- +goose Up
/* Login security: what the Logins screen could not yet say or do.

   login_events   every sign-in attempt, kept: success, wrong password, no
                  such account, locked out, second factor failed, and the
                  step-up re-checks a money screen asks for. Failed attempts
                  used to go only to the process log and vanish.
   login_throttle the lockout counter, in Postgres. It was in process
                  memory, which on Cloud Run means a new instance or a
                  restart forgot the count: eight guesses, restart, eight
                  more. One row per identifier.
   sessions       ended_reason says how a session ended (signed out, idle,
                  revoked by the office, superseded by a newer device,
                  password changed, everyone signed out); idle_seconds is
                  the per-session idle limit its role's policy set at issue.
                  reauth_at is the last time the person retyped their
                  password for a money action.
   session_policies  per role: how long a session lives, how long it may
                  sit idle, how many devices may hold one at once. The
                  single global 12h/2h treated the accountant and a parent
                  alike, and neither was right. */

CREATE TABLE IF NOT EXISTS login_events (
    id              bigserial PRIMARY KEY,
    institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    -- What was typed, so failures against an account that does not exist
    -- are still visible as a pattern. Never the password.
    identifier      text NOT NULL DEFAULT '',
    outcome         text NOT NULL,
    via             text NOT NULL DEFAULT 'password',
    ip              inet,
    user_agent      text,
    session_id      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT login_events_outcome CHECK (outcome IN (
        'success', 'wrong_password', 'no_account', 'locked', 'school_paused',
        'ambiguous', 'mfa_failed', 'mfa_required', 'reauth_ok', 'reauth_failed'))
);
CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_inst_idx ON login_events (institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_identifier_idx ON login_events (identifier, created_at DESC);
ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON login_events
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

CREATE TABLE IF NOT EXISTS login_throttle (
    identifier    text PRIMARY KEY,
    failures      integer NOT NULL DEFAULT 0,
    locked_until  timestamptz,
    last_seen     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_reason text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_seconds integer;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reauth_at timestamptz;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_ended_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_ended_reason_check CHECK (ended_reason IS NULL OR ended_reason IN (
    'signed_out', 'idle', 'revoked', 'superseded', 'password_changed', 'all_signed_out', 'deactivated'));
CREATE INDEX IF NOT EXISTS sessions_inst_live_idx ON sessions (institution_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS session_policies (
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    role_key        text NOT NULL,
    absolute_hours  integer NOT NULL,
    idle_minutes    integer NOT NULL,
    max_devices     integer NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (institution_id, role_key),
    CONSTRAINT session_policies_sane CHECK (
        absolute_hours BETWEEN 1 AND 24*180 AND idle_minutes BETWEEN 5 AND 60*24*60
        AND max_devices BETWEEN 1 AND 20)
);
ALTER TABLE session_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_policies
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

COMMENT ON TABLE login_events IS
    'Every sign-in attempt and step-up check, kept. Read by the Logins screen per account and per school.';
COMMENT ON TABLE session_policies IS
    'Per-role session lifetime, idle limit and device cap. Absent row = built-in default for that role (internal/auth/policy.go).';

-- +goose Down
DROP TABLE IF EXISTS session_policies;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_ended_reason_check;
DROP INDEX IF EXISTS sessions_inst_live_idx;
ALTER TABLE sessions DROP COLUMN IF EXISTS ended_reason, DROP COLUMN IF EXISTS idle_seconds, DROP COLUMN IF EXISTS reauth_at;
DROP TABLE IF EXISTS login_throttle;
DROP TABLE IF EXISTS login_events;
