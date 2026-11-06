-- 0132_yajur_connect_send (tenant: every school database).
-- Yajur Connect sending: broadcasts kept as campaign snapshots, and schedules
-- that queue a broadcast later or on repeat. Every message still goes through
-- message_log (source_kind 'wa_campaign', source_id the campaign), so the
-- recipient guard, opt-outs and quiet hours apply as to any other send.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- What a broadcast was, as sent: template, the values typed (JSON object,
-- may hold {{parent_name}} {{student_name}} {{class}}), the text with those
-- values in, the audience (JSON: scope school|classes|sections, ids, relation
-- father|mother|both) and how many were queued. Statuses are read live from
-- message_log, not copied here.
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template_code TEXT NOT NULL,
  template_name TEXT,
  template_values TEXT NOT NULL DEFAULT '{}',
  rendered TEXT NOT NULL DEFAULT '',
  header_image_url TEXT,
  audience TEXT NOT NULL DEFAULT '{}',
  audience_label TEXT NOT NULL DEFAULT '',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0,
  schedule_id TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_campaigns_created_idx ON wa_campaigns (created_at);

-- A broadcast to queue later. repeat: once | daily | weekly | monthly.
-- next_run_at is claimed with a compare-and-set, so one firing queues once.
CREATE TABLE IF NOT EXISTS wa_schedules (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repeat TEXT NOT NULL CHECK (repeat IN ('once', 'daily', 'weekly', 'monthly')),
  first_run_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_campaign_id TEXT,
  last_error TEXT,
  payload TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_schedules_due_idx ON wa_schedules (active, next_run_at);
