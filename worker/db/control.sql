-- The platform database. One per deployment. Everything a request needs
-- before it knows which school it is for.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  locale TEXT NOT NULL DEFAULT 'en-IN',
  primary_color TEXT NOT NULL DEFAULT '#1e40af',
  logo_key TEXT,
  teacher_day_code_secret BLOB,
  -- White label (Tenants → Branding): the sign-in page at /<country>/<slug>
  -- or on custom_domain, with this school's logo, colours and words.
  country TEXT NOT NULL DEFAULT 'in',
  accent_color TEXT,
  tagline TEXT,
  login_headline TEXT,
  login_message TEXT,
  support_email TEXT,
  support_phone TEXT,
  custom_domain TEXT,
  -- Store id of the school's own apps (scripts/apps/build-school.sh).
  app_id TEXT,
  -- The school's own D1 database, and the Worker binding that reaches it.
  d1_database_id TEXT NOT NULL,
  d1_binding TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS institutions_custom_domain ON institutions (custom_domain COLLATE NOCASE) WHERE custom_domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS institutions_app_id ON institutions (app_id) WHERE app_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_paise INTEGER NOT NULL DEFAULT 0,
  price_monthly_paise INTEGER,
  max_students INTEGER,
  max_campuses INTEGER,
  max_storage_gb INTEGER,
  modules TEXT NOT NULL DEFAULT '{}',
  sequence INTEGER NOT NULL DEFAULT 0,
  custom_integration INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES plans(code),
  status TEXT NOT NULL DEFAULT 'trial',
  started_on TEXT NOT NULL,
  renews_on TEXT,
  trial_ends_on TEXT,
  licensed_students INTEGER,
  agreed_price_paise INTEGER,
  storage_gb INTEGER,
  notes TEXT,
  updated_at TEXT NOT NULL
);

-- Platform staff: the vendor's own accounts, belonging to no school.
CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  username TEXT UNIQUE COLLATE NOCASE,
  phone TEXT UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who can sign in with what. Postgres answered "which accounts use this
-- email" with one query across every school; with a database per school
-- that question needs an index here. Kept in step by the tenant user
-- handlers whenever an email, phone or username changes.
CREATE TABLE IF NOT EXISTS login_index (
  kind TEXT NOT NULL CHECK (kind IN ('email','phone','username')),
  value TEXT NOT NULL COLLATE NOCASE,
  institution_id TEXT REFERENCES institutions(id) ON DELETE CASCADE,  -- NULL = platform user
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value, institution_id, user_id)
);
CREATE INDEX IF NOT EXISTS login_index_value ON login_index(value);

-- Sessions live here, not per school: the cookie arrives before the school
-- is known, and a platform admin has no school at all.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,          -- hex sha256 of the cookie value
  institution_id TEXT REFERENCES institutions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  via TEXT NOT NULL DEFAULT 'password',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ended_reason TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  identifier TEXT,
  outcome TEXT NOT NULL,
  institution_id TEXT,
  user_id TEXT,
  ip TEXT,
  user_agent TEXT
);

-- Sign-in throttle: replaces the Go server's in-memory limiter, which one
-- Worker isolate cannot share with the next.
CREATE TABLE IF NOT EXISTS login_throttle (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  locked_until TEXT
);

-- ---- Seller desk (ported from seller_crm.go, platform_log.go,
-- platform_usage.go, platform_broadcast.go, support_accounts.go) ----------

CREATE TABLE IF NOT EXISTS platform_user_roles (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,   -- 'super_admin' | 'seller_admin' | 'support_admin'
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_key)
);

CREATE TABLE IF NOT EXISTS purchase_enquiries (
  id TEXT PRIMARY KEY, school_name TEXT NOT NULL, contact_name TEXT NOT NULL,
  email TEXT COLLATE NOCASE, phone TEXT, district TEXT, state TEXT, board TEXT, students INTEGER,
  plan_code TEXT REFERENCES plans(code) ON DELETE SET NULL, message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','demo_booked','won','lost')),
  provisioned_institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'website',
  owner_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  next_follow_up TEXT, lost_reason TEXT, value_paise INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS purchase_enquiries_open ON purchase_enquiries(created_at DESC) WHERE status IN ('new','contacted','demo_booked');

CREATE TABLE IF NOT EXISTS purchase_enquiry_notes (
  id TEXT PRIMARY KEY, enquiry_id TEXT NOT NULL REFERENCES purchase_enquiries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','stage','call','email','meeting')),
  body TEXT NOT NULL, author_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
  institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  actor_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_events_at ON platform_events(at);

CREATE TABLE IF NOT EXISTS platform_costs (
  id INTEGER PRIMARY KEY CHECK (id = 1), infra_paise INTEGER NOT NULL DEFAULT 0,
  storage_paise_per_gb INTEGER NOT NULL DEFAULT 0, sms_paise INTEGER NOT NULL DEFAULT 0,
  email_paise INTEGER NOT NULL DEFAULT 0, whatsapp_paise INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '', updated_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO platform_costs (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE IF NOT EXISTS platform_broadcasts (
  id TEXT PRIMARY KEY, severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL, ends_at TEXT,
  created_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, retired_at TEXT,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

-- Password reset links (internal/api/password_reset.go). Here rather than in
-- the school's database: /reset?token= arrives with no school attached, so the
-- row names the school (NULL = a platform_users account). token_hash is hex
-- sha256 of the token; the token itself is never stored.
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at);
CREATE INDEX IF NOT EXISTS password_resets_expiry ON password_resets(expires_at) WHERE used_at IS NULL;

-- Self-service purchase orders (/signup, internal/api/signup.go): created
-- before any school exists, so they belong to the platform.
CREATE TABLE IF NOT EXISTS signup_orders (
  id TEXT PRIMARY KEY,
  school_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT, district TEXT, state TEXT, board TEXT, students INTEGER,
  admin_username TEXT COLLATE NOCASE,
  plan_code TEXT NOT NULL REFERENCES plans(code) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL,
  order_ref TEXT NOT NULL UNIQUE,
  payment_ref TEXT, signature TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  failure_reason TEXT,
  institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,
  admin_user_id TEXT,
  credentials_sent_at TEXT,
  billing_period TEXT NOT NULL DEFAULT 'yearly',
  created_at TEXT NOT NULL, paid_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_orders_status ON signup_orders(status);

-- ---- Background jobs (replaces River's river_job / river_queue) ----------
-- One row per enqueued job, written by enqueue() and moved through its
-- states by runBatch() (src/services/jobs.ts). States use the vocabulary the
-- Go inspector showed the screens: pending, active, retry, archived
-- (gave up), completed. Pruned after a day by the security:retention sweep,
-- the retention window GET /jobs/{id} always promised.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'default',
  institution_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_queue_state ON jobs(queue, state);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);

-- Cron memory for the installation-wide entries (the per-school entries
-- keep theirs in each school's own cron_runs). See src/services/cron.ts.
CREATE TABLE IF NOT EXISTS cron_runs (
  name TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);

-- ---- School groups (Seller → School groups) ------------------------------
-- One organisation owning several schools ("Yajur Branch 1", "Yajur Branch
-- 2"). Each school keeps its own database; the group is only a label here
-- plus who may look across it. Not Go's franchises (a brand/royalty contract,
-- empty in production): a group is ownership.
CREATE TABLE IF NOT EXISTS school_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A school is in at most one group.
CREATE TABLE IF NOT EXISTS school_group_members (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES school_groups(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS school_group_members_group ON school_group_members(group_id);

-- Group admins: a school user (signed in at their home school) who is a
-- board member of every school in the group and may read its combined report.
CREATE TABLE IF NOT EXISTS school_group_admins (
  group_id TEXT NOT NULL REFERENCES school_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  home_institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS school_group_admins_user ON school_group_admins(user_id);

-- Board memberships across schools. The grant itself is a board_member
-- user_roles row in the overseen school's own database; this index is how a
-- request learns, before opening any school, which schools a user may switch
-- into (GET /me/institutions, X-Acting-Institution in identity.ts). Written
-- by the /seller/board-members and /seller/school-groups handlers; rebuilt
-- from the schools by GET /seller/board-members. via_group names the group
-- that granted it (NULL = granted directly), so leaving a group removes only
-- what the group gave.
CREATE TABLE IF NOT EXISTS board_memberships (
  user_id TEXT NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  home_institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  via_group TEXT REFERENCES school_groups(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, institution_id)
);

-- ---- School health board and usage alerts (Seller → Instance Health) --
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


-- A seller's override of one catalogue feature for one school, on top of what
-- the plan's modules give. feature_id is '<section>.<feature>' (the catalogue
-- key without its role, so one switch covers every role that shows it).
-- enabled 1 = on even if the plan leaves the module out; 0 = off even if the
-- plan includes it. ends_at (optional) is when the override lapses and the
-- plan default returns: a trial, or a temporary switch-off.
CREATE TABLE IF NOT EXISTS school_feature_overrides (
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  ends_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  set_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, feature_id)
);
CREATE INDEX IF NOT EXISTS school_feature_overrides_feature ON school_feature_overrides(feature_id);

-- Who a platform broadcast is for. No row = every school, every audience
-- (the broadcasts raised before this table existed).
-- target_kind: all | group | plan | schools; target_ids: JSON list of group
-- ids, plan codes or institution ids. audiences: JSON list drawn from
-- admins, staff, parents (parents includes students).
CREATE TABLE IF NOT EXISTS platform_broadcast_targets (
  broadcast_id TEXT PRIMARY KEY REFERENCES platform_broadcasts(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL DEFAULT 'all' CHECK (target_kind IN ('all','group','plan','schools')),
  target_ids TEXT NOT NULL DEFAULT '[]',
  audiences TEXT NOT NULL DEFAULT '["admins","staff","parents"]',
  updated_at TEXT NOT NULL
);

-- Who has seen / dismissed a broadcast, per school user.
CREATE TABLE IF NOT EXISTS platform_broadcast_reads (
  broadcast_id TEXT NOT NULL REFERENCES platform_broadcasts(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  dismissed_at TEXT,
  PRIMARY KEY (broadcast_id, institution_id, user_id)
);
CREATE INDEX IF NOT EXISTS platform_broadcast_reads_school ON platform_broadcast_reads(broadcast_id, institution_id);

-- Schools being created from the seller console (db/changes/control_provisioning.sql).
CREATE TABLE IF NOT EXISTS provisioning (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  country TEXT NOT NULL DEFAULT 'in',
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  plan_code TEXT,
  trial_days INTEGER NOT NULL DEFAULT 30,
  district TEXT,
  state TEXT,
  affiliation_board TEXT,
  admin_name TEXT NOT NULL,
  admin_email TEXT,
  admin_phone TEXT,
  admin_username TEXT,
  -- Only the hash: the one-time password is returned once, to the seller who asked.
  admin_password_hash TEXT NOT NULL,
  -- {primary_color, accent_color, tagline, support_email, support_phone}
  branding TEXT NOT NULL DEFAULT '{}',
  institution_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  db_name TEXT NOT NULL,
  d1_database_id TEXT,
  d1_binding TEXT NOT NULL,
  -- 1 once this row's job created the database, so only then may a discard delete it.
  db_created INTEGER NOT NULL DEFAULT 0,
  -- queued | creating_database | applying_schema | seeding | attaching | ready | failed
  stage TEXT NOT NULL DEFAULT 'queued',
  failed_stage TEXT,
  error TEXT,
  schema_done INTEGER NOT NULL DEFAULT 0,
  schema_total INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  job_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS provisioning_created ON provisioning(created_at);

-- Backups, exports, off-boarding and the seller audit (db/changes/control_lifecycle.sql).
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

-- ---- Seller billing (Seller → Subscription ledger; school Settings → Billing) --
-- Invoices the vendor issues to each school for its subscription, payments
-- against them, renewal reminders and the onboarding tracker. Written by
-- src/routes/seller/billing.ts and src/routes/seller/onboarding.ts.

-- One row: who the seller is on an invoice, the GST rate and the grace periods
-- the daily billing job (billing:daily) applies.
CREATE TABLE IF NOT EXISTS billing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seller_name TEXT NOT NULL DEFAULT '',
  seller_address TEXT NOT NULL DEFAULT '',
  seller_gstin TEXT NOT NULL DEFAULT '',
  seller_email TEXT NOT NULL DEFAULT '',
  bank_details TEXT NOT NULL DEFAULT '',
  upi_vpa TEXT NOT NULL DEFAULT '',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  gst_rate_bp INTEGER NOT NULL DEFAULT 1800,          -- basis points: 1800 = 18%
  due_days INTEGER NOT NULL DEFAULT 15,               -- issued_on + due_days = due_on
  grace_days INTEGER NOT NULL DEFAULT 15,             -- past_due after due_on + grace_days
  suspend_after_days INTEGER NOT NULL DEFAULT 30,     -- suspended after a further this many days
  updated_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO billing_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Numbered per Indian financial year (April to March): INV/2026-27/0001.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  plan_code TEXT,
  billing_period TEXT NOT NULL DEFAULT 'yearly',
  description TEXT NOT NULL,
  school_gstin TEXT,
  amount_paise INTEGER NOT NULL,                      -- taxable value
  gst_rate_bp INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  paid_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partial','paid','void')),
  seller_gstin TEXT NOT NULL DEFAULT '',
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS billing_invoices_school ON billing_invoices(institution_id, issued_on);
CREATE INDEX IF NOT EXISTS billing_invoices_open ON billing_invoices(due_on) WHERE status IN ('issued','partial');

CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL CHECK (method IN ('upi','neft','cheque','cash','online')),
  reference TEXT,
  paid_on TEXT NOT NULL,
  gateway_order_ref TEXT UNIQUE,
  recorded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_payments_invoice ON billing_payments(invoice_id);

-- Online payment attempts through the platform gateway (PAYMENT_GATEWAY_SECRET).
CREATE TABLE IF NOT EXISTS billing_gateway_orders (
  order_ref TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  payment_ref TEXT,
  failure_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

-- Renewal reminders already queued: one per school, renewal date and step (30/7/1).
CREATE TABLE IF NOT EXISTS billing_reminders (
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  renews_on TEXT NOT NULL,
  days_before INTEGER NOT NULL,
  recipient TEXT,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, renews_on, days_before)
);

-- Subscription status changes the billing job made, for the ledger.
CREATE TABLE IF NOT EXISTS billing_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL
);

-- ---- Onboarding tracker (Seller → Schools → Setup) ------------------------
-- The first time each milestone was seen, read from each school's own D1 by
-- the onboarding:scan job. A date once recorded is kept.
CREATE TABLE IF NOT EXISTS onboarding_progress (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  admin_signed_in_at TEXT,
  profile_complete_at TEXT,
  classes_set_up_at TEXT,
  students_imported_at TEXT,
  staff_added_at TEXT,
  first_attendance_at TEXT,
  first_fee_at TEXT,
  first_parent_signed_in_at TEXT,
  scan_error TEXT,
  checked_at TEXT NOT NULL,
  last_nudged_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0
);
