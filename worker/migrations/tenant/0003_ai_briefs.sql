-- 0003_ai_briefs (tenant: every school database).
-- Generated AI briefs (principal morning brief, student 360 summary, weekly
-- parent note) with the hash of the inputs they were written from, so an
-- unchanged day is not regenerated; and a per-day count of model calls, for
-- the school's daily cost cap (module_settings module 'ai', config.daily_cap).
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

CREATE TABLE IF NOT EXISTS ai_briefs (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  -- 'principal_morning' | 'student_360' | 'parent_weekly'
  kind TEXT NOT NULL,
  -- what it is about: a student id, or '' for the whole school
  subject_id TEXT NOT NULL DEFAULT '',
  -- the day or ISO week it covers ('2026-09-27', '2026-W39'), '' when open-ended
  period_key TEXT NOT NULL DEFAULT '',
  inputs_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  -- the facts behind the text (links, figures) as JSON, for the screen
  facts TEXT NOT NULL DEFAULT '{}',
  model TEXT NOT NULL,
  generated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (kind, subject_id, period_key)
);
CREATE INDEX IF NOT EXISTS ai_briefs_kind_created ON ai_briefs (kind, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  on_date TEXT NOT NULL PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
