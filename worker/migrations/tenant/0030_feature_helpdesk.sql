-- 0030_feature_helpdesk (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Helpdesk (help.helpdesk), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('help.desk.read', 'help', 'View Helpdesk');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('help.desk.write', 'help', 'Manage Helpdesk');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.help.helpdesk', 'institution_admin', 'Requests for help from families and staff of this school. Answer them here, or pass one to XULO support with a summary that names no child.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.help.helpdesk' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'help.desk.read' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'help.desk.write' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
