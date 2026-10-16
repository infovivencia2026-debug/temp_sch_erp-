-- 0090_feature_subject_overview (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Subject overview (academics.subject_overview), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hod.academics.subject_overview', 'hod', 'For each subject''s head: every teacher of that subject from Grade 1 up, their classes, periods, average marks and lesson plans; the subject''s timetable across all classes; notices those teachers posted; and meetings the head calls, sent to ');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.academics.subject_overview', 'institution_admin', 'For each subject''s head: every teacher of that subject from Grade 1 up, their classes, periods, average marks and lesson plans; the subject''s timetable across all classes; notices those teachers posted; and meetings the head calls, sent to ');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hod.academics.subject_overview' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.academics.subject_overview' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
