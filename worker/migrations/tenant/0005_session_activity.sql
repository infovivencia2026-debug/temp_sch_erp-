-- 0005_session_activity (tenant: every school database).
-- Session activity recording, a per-school switch that is OFF by default
-- (module_settings module 'session_activity'; config.retention_days, default
-- 90). Nothing is written to these tables while the switch is off. When it is
-- on: one row per sign-in (device, browser, address, approximate place,
-- sign-in / sign-out, last active, total active time) and one row per screen
-- visit with the time spent on it. Changes made in a session are not copied:
-- audit_log already carries session_id and the timeline joins it.
-- The security:retention cron purges both tables past the retention period.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS session_activity (
  session_id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  via TEXT,
  signed_in_at TEXT NOT NULL,
  signed_out_at TEXT,
  ended_reason TEXT,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  city TEXT,
  region TEXT,
  country TEXT,
  last_active_at TEXT,
  active_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_activity_signed_in ON session_activity (signed_in_at);
CREATE INDEX IF NOT EXISTS session_activity_user ON session_activity (user_id, signed_in_at);

CREATE TABLE IF NOT EXISTS session_activity_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- the catalogue feature key (e.g. finance.fee_counter), and the address
  screen TEXT NOT NULL,
  path TEXT,
  started_at TEXT NOT NULL,
  -- visible (foreground) time on the screen
  seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_activity_views_session ON session_activity_views (session_id, started_at);
CREATE INDEX IF NOT EXISTS session_activity_views_started ON session_activity_views (started_at);
