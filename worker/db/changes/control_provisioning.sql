-- control_provisioning (CONTROL D1 only). A school the seller creates from
-- Tenants → New school: one row per request, walked through its stages by
-- the 'school:provision' job (src/services/provision.ts). The row outlives
-- the job so the console can show progress, the error and a Retry, and so a
-- retry resumes where the last attempt stopped. The slug is reserved here
-- from the moment the request is accepted.
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
