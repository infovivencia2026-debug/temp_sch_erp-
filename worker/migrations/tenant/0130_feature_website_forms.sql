-- 0130_feature_website_forms (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Website forms (communication.website_forms), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.communication.website_forms', 'institution_admin', 'Build forms like Google Forms for the school website (careers, contact, events and more). Copy the embed code to the website; every response lands here with its date and time.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.communication.website_forms' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;

-- Website forms (owner, 2026-11-05): forms the school builds here and puts on
-- its website, by embed or by its own form posting to the public address.
-- fields: JSON [{key, label, type, required, options}]. A response keeps
-- every value sent, the files, where it came from and when.
CREATE TABLE IF NOT EXISTS website_forms (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  submit_label TEXT,
  thanks_message TEXT,
  is_open INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS website_form_responses (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  form_id TEXT NOT NULL REFERENCES website_forms (id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  files TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'embed' CHECK (source IN ('embed', 'post')),
  page_url TEXT,
  ip TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS website_form_responses_form ON website_form_responses (form_id, created_at);
