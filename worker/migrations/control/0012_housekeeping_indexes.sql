-- 0012_housekeeping_indexes (CONTROL).
-- Keeps CONTROL small and its sweeps cheap: indexes for the retention
-- deletes (services/background/housekeeping.ts), which scanned sessions,
-- login_events, login_throttle and jobs. Also cache_versions, which
-- src/idcache.ts has so far created at runtime (CREATE TABLE IF NOT EXISTS):
-- the same definition, so a database that already has it is unchanged.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_created ON sessions (created_at);
CREATE INDEX IF NOT EXISTS login_events_at ON login_events (at);
CREATE INDEX IF NOT EXISTS login_events_user_at ON login_events (user_id, at);
CREATE INDEX IF NOT EXISTS login_throttle_window ON login_throttle (window_started_at);
CREATE INDEX IF NOT EXISTS jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS login_index_institution ON login_index (institution_id);

-- The identity cache's version per school ('*' for the platform); src/idcache.ts.
CREATE TABLE IF NOT EXISTS cache_versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
