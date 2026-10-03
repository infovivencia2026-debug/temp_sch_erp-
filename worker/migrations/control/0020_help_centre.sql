-- 0020_help_centre (CONTROL).
-- The Help Centre and the support desk, the parts that are one for every school.
--
-- error_refs: every unexpected error the Worker answers gets a six-character
--   reference the person can read out ("Ref: K7Q2X9"); the row says which
--   route, school, user and role, and what was thrown. Kept 14 days
--   (services/background/housekeeping.ts, security:retention).
-- help_content: help articles, tips, canned replies, request categories and
--   the SLA policy, written once at the desk and read by every school. The
--   shipped defaults live in code (worker/src/routes/help/content.ts); a row
--   here replaces the default with the same key, adds a new one, or hides one.
-- help_incidents: a known issue with its workaround, matched to new requests
--   by route, category and school.
-- assist_codes: "Let support see my screen": a six-digit code a signed-in
--   person reads out, valid 15 minutes, used once.
--
-- Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS error_refs (
  code TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  institution_id TEXT,
  user_id TEXT,
  user_name TEXT,
  role TEXT,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  message TEXT NOT NULL,
  release TEXT
);
CREATE INDEX IF NOT EXISTS error_refs_at ON error_refs (at);
CREATE INDEX IF NOT EXISTS error_refs_school ON error_refs (institution_id, at);

CREATE TABLE IF NOT EXISTS help_content (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  updated_by_name TEXT,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS help_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workaround TEXT NOT NULL,
  routes TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  institution_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  broadcast_id TEXT,
  linked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT,
  created_by_name TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS help_incidents_open ON help_incidents (status, created_at);

CREATE TABLE IF NOT EXISTS assist_codes (
  code TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  role TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  used_by_name TEXT,
  grant_id TEXT
);
CREATE INDEX IF NOT EXISTS assist_codes_user ON assist_codes (institution_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS assist_attempts (
  user_id TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);
