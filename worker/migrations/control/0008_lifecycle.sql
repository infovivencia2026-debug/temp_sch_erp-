-- control_lifecycle (CONTROL D1 only). Backups, school exports and
-- off-boarding, and the append-only register of seller/platform actions.
-- See src/services/background/backup.ts, src/routes/seller/lifecycle.ts and
-- src/services/seller_audit.ts. Apply once:
--   npm run migrate -- up (was db/changes/control_lifecycle.sql)

-- One row per SQL dump written to R2 (backups/<slug>/<date>.sql.gz).
-- institution_id NULL is the CONTROL database itself.
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  institution_id TEXT,
  scope TEXT NOT NULL DEFAULT 'school',        -- school | control
  kind TEXT NOT NULL DEFAULT 'nightly',        -- nightly | manual
  backup_date TEXT NOT NULL,                   -- YYYY-MM-DD (UTC)
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',      -- running | succeeded | failed | pruned | replaced
  tables INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  error TEXT,
  requested_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pruned_at TEXT
);
CREATE INDEX IF NOT EXISTS backups_school ON backups (institution_id, started_at);
CREATE INDEX IF NOT EXISTS backups_key ON backups (object_key);

-- Point-in-time restores through D1 Time Travel. pre_bookmark is where the
-- database stood just before the restore, so the restore can be undone.
CREATE TABLE IF NOT EXISTS restores (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  d1_database_id TEXT NOT NULL,
  target_timestamp TEXT,
  target_bookmark TEXT,
  pre_bookmark TEXT,
  result_bookmark TEXT,
  undoes_restore_id TEXT,
  status TEXT NOT NULL,                        -- dry_run | succeeded | failed
  error TEXT,
  reason TEXT,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS restores_school ON restores (institution_id, created_at);

-- Full exports of one school: every table as CSV plus a files manifest, in
-- one ZIP, downloadable until expires_at.
CREATE TABLE IF NOT EXISTS school_exports (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'request',     -- request | offboarding
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | ready | failed | expired
  object_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  tables INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_by TEXT,
  requested_by_name TEXT,
  requested_by_platform INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS school_exports_school ON school_exports (institution_id, created_at);

-- Where each school is in off-boarding. No row = active.
-- state: active | leaving | read_only | archived | delete_pending | deleted
CREATE TABLE IF NOT EXISTS school_lifecycle (
  institution_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active',
  read_only_days INTEGER NOT NULL DEFAULT 30,
  leaving_at TEXT,
  export_id TEXT,
  read_only_at TEXT,
  read_only_until TEXT,
  archived_at TEXT,
  prior_status TEXT,
  delete_requested_at TEXT,
  delete_requested_by TEXT,
  deleted_at TEXT,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_lifecycle_events (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  step TEXT NOT NULL,
  detail TEXT,
  actor_id TEXT,
  actor_name TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS school_lifecycle_events_school ON school_lifecycle_events (institution_id, at);

-- Every write by a seller, support or platform account: seller routes,
-- acting inside a school, restores, feature switches, billing. Append-only:
-- no route updates or deletes it, and the triggers refuse it anyway.
CREATE TABLE IF NOT EXISTS seller_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  actor_roles TEXT,
  acting_as INTEGER NOT NULL DEFAULT 0,        -- 1 when done inside a school (X-Acting-Institution)
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  route TEXT,
  action TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  target TEXT,
  before_summary TEXT,
  after_summary TEXT,
  status INTEGER,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS seller_audit_at ON seller_audit (at);
CREATE INDEX IF NOT EXISTS seller_audit_school ON seller_audit (institution_id, at);
CREATE INDEX IF NOT EXISTS seller_audit_actor ON seller_audit (actor_id, at);
CREATE TRIGGER IF NOT EXISTS seller_audit_no_update BEFORE UPDATE ON seller_audit
BEGIN SELECT RAISE(ABORT, 'seller_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS seller_audit_no_delete BEFORE DELETE ON seller_audit
BEGIN SELECT RAISE(ABORT, 'seller_audit is append-only'); END;
