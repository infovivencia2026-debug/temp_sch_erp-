-- 0092_feature_subject_meetings (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Subject meetings (academics.subject_meetings), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('faculty.academics.subject_meetings', 'faculty', 'Meetings your subject head has called. See the date, place and agenda, and answer Attending or Can''t come with a note.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hod.academics.subject_meetings', 'hod', 'Meetings your subject head has called. See the date, place and agenda, and answer Attending or Can''t come with a note.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'faculty.academics.subject_meetings' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hod.academics.subject_meetings' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;

-- A teacher's answer to a subject meeting: 'yes' (attending) or 'no' (can't come), with a note.
CREATE TABLE IF NOT EXISTS subject_meeting_replies (
  meeting_id TEXT NOT NULL REFERENCES subject_meetings (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL,
  reply TEXT NOT NULL CHECK (reply IN ('yes','no')),
  note TEXT,
  replied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (meeting_id, user_id)
);
