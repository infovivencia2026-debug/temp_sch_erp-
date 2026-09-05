-- One table for the rate limiters to share, so a count survives a restart and
-- is the same count on every instance.
--
-- internal/ratelimit keeps one row here per allowed attempt: which limiter
-- (scope), whom it was counting (subject -- a caller's address, an API key's
-- id, a test link's key), and when. Rows are counted inside a window and swept
-- as they leave it; nothing ever reads one back by itself, so there is no id.
-- The limiter code documents the two algorithms and their sweeps.
--
-- Only used when RATE_LIMIT_STORE=postgres. The in-memory store is the
-- default and never touches this table, so applying the migration changes
-- nothing on a deployment that has not opted in.
--
-- No RLS. A limiter's subject is a network address or a key id, not a tenant's
-- row, and the platform-scoped transaction the store runs in would satisfy a
-- tenant policy anyway. FORCE ROW LEVEL SECURITY applies only to tables with a
-- policy, so this one is unaffected by it. The grant is what 00250 does for
-- River's tables: 00042's default privileges cover it when the migrator's role
-- created it, and the explicit grant covers the case where it did not.

-- +goose Up

CREATE TABLE rate_limit_hits (
    scope   text        NOT NULL,
    subject text        NOT NULL,
    hit_at  timestamptz NOT NULL
);

-- The one access path: every statement the store runs names a scope, and all
-- but the sweep name a subject and a range of hit_at.
CREATE INDEX rate_limit_hits_scope_subject_hit_at_idx
    ON rate_limit_hits (scope, subject, hit_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_hits TO app_user;

-- +goose Down

DROP TABLE IF EXISTS rate_limit_hits;
