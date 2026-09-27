-- control_health (CONTROL D1 only). School health board and usage alerts
-- (Seller → Instance Health). Idempotent; apply with
--   npm run migrate -- up (was db/changes/control_health.sql)
-- The board fills on the next seller:health_snapshot run (every 15 min) or
-- from its Refresh button.

-- Server errors (5xx) per school, per UTC hour; written by the Worker's
-- error path (src/services/background/health.ts recordServerError).
CREATE TABLE IF NOT EXISTS school_errors (
  institution_id TEXT NOT NULL,
  hour TEXT NOT NULL,                 -- 'YYYY-MM-DDTHH'
  count INTEGER NOT NULL DEFAULT 0,
  last_path TEXT,
  last_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, hour)
);

-- The board's cache: one JSON row per school, rewritten by the snapshot job.
CREATE TABLE IF NOT EXISTS school_health (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- Use against plan limits: the current alert per school and metric
-- (students, storage, sms). level 80 or 100; the row goes when use drops
-- below 80%. notified_level: the highest level admins were told about.
CREATE TABLE IF NOT EXISTS usage_alerts (
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  level INTEGER NOT NULL,
  used REAL NOT NULL,
  lim REAL NOT NULL,
  pct INTEGER NOT NULL,
  message TEXT NOT NULL,
  notified_level INTEGER NOT NULL DEFAULT 0,
  raised_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, metric)
);

CREATE INDEX IF NOT EXISTS sessions_institution ON sessions(institution_id, last_seen_at);
CREATE INDEX IF NOT EXISTS jobs_institution ON jobs(institution_id, state);
