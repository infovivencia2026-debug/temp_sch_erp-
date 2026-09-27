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
