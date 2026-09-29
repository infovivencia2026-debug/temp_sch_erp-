-- 0011_dead_letters (CONTROL D1 only).
-- Jobs that exhausted their retries land in the dead-letter queue
-- (school-erp-jobs-dlq). Its consumer (services/dead_letters.ts) records each
-- one here and alerts the platform admin once per job type per hour.
-- Additive only. Forward-only.
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT,
  type TEXT NOT NULL,
  institution_id TEXT,
  payload TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  alerted_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS dead_letters_recent ON dead_letters (created_at);
CREATE INDEX IF NOT EXISTS dead_letters_by_type ON dead_letters (type, created_at);
