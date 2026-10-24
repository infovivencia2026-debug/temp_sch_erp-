-- 0056_support_ticket_index (control: CONTROL only).
-- The vendor's support desk without a fleet scan per request:
--  * plans.sla_tier: the row of the SLA policy's vendor table a plan is held
--    to (0 = fastest .. 3). NULL keeps the old mapping by plan code
--    (routes/help/content.ts vendorHours).
--  * support_ticket_index: one row per vendor ticket of every school, written
--    after each write to a ticket (services/ticket_index.ts) and rebuilt
--    nightly; the queue reads it, paged. waiting_since / waiting_seconds are
--    the time a ticket spent waiting on the school, in business seconds,
--    which the SLA clock leaves out.
--  * support_index_sync: when each school was last copied, and why not.
--  * platform_notifications: a note for one platform account (the SLA
--    breach alert). source_key makes each alert once per person.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE plans ADD COLUMN sla_tier INTEGER CHECK (sla_tier IS NULL OR sla_tier BETWEEN 0 AND 3);

CREATE TABLE IF NOT EXISTS support_ticket_index (
  institution_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  school TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  raised_by TEXT,
  assigned_to TEXT,
  agent_id TEXT,
  last_reply_side TEXT,
  last_reply_at TEXT,
  parent_ticket_id TEXT,
  merged_into TEXT,
  route TEXT,
  error_ref TEXT,
  body TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  waiting_since TEXT,
  waiting_seconds INTEGER NOT NULL DEFAULT 0,
  response_alerted_at TEXT,
  breach_alerted_at TEXT,
  PRIMARY KEY (institution_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS support_ticket_index_status ON support_ticket_index (status, created_at);

CREATE TABLE IF NOT EXISTS support_index_sync (
  institution_id TEXT PRIMARY KEY,
  synced_at TEXT,
  error TEXT,
  tried_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  source_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS platform_notifications_user ON platform_notifications (user_id, created_at);
