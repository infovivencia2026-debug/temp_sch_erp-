-- +goose Up

-- WHAT WENT WRONG, KEPT PER SCHOOL, FOR THE DAY SOMEBODY ASKS.
--
-- audit_log records every change a person made. It does not record what the
-- system itself said while it worked: the warning that a message could not
-- be queued, the error that a payment allocation rolled back, the sweep that
-- skipped a school. Those went to stdout as JSON, which on Cloud Run means
-- Cloud Logging, which keeps them thirty days and knows nothing of tenants.
-- The question "what happened at this school on that afternoon" -- the one a
-- principal asks two months later -- had nothing to read.
--
-- So every WARN and ERROR the process emits is also written here, stamped
-- with the school the request was serving (NULL for the platform's own
-- work), the request id that ties it to the request line, and the user. It
-- is a log, not a ledger: written asynchronously and dropped rather than
-- blocking a request if the sink cannot keep up. Never purged; a school's
-- history is the school's.
CREATE TABLE app_events (
    id             bigserial    PRIMARY KEY,
    institution_id uuid         REFERENCES institutions(id) ON DELETE CASCADE,
    user_id        uuid,
    request_id     text,
    source         text         NOT NULL,   -- 'web' | 'worker'
    level          text         NOT NULL,   -- 'WARN' | 'ERROR'
    message        text         NOT NULL,
    attrs          jsonb        NOT NULL DEFAULT '{}'::jsonb,
    at             timestamptz  NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_events IS
    'WARN and ERROR log records, per school, never purged. Written by internal/eventlog from the slog stream; read on the platform console and the school''s own Audit & jobs screen.';

CREATE INDEX app_events_institution_id_idx ON app_events (institution_id, id DESC);
CREATE INDEX app_events_at_idx ON app_events (at DESC);

ALTER TABLE app_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY app_events_tenant ON app_events
    USING      (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT ON app_events TO app_user;
GRANT USAGE, SELECT ON SEQUENCE app_events_id_seq TO app_user;

-- +goose Down
DROP TABLE IF EXISTS app_events;
