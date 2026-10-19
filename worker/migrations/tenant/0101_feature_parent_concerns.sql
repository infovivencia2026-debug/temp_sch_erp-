-- 0101_feature_parent_concerns (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Parent concerns (communication.parent_concerns), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('front_office.communication.parent_concerns', 'front_office', 'Concerns parents send to the front desk. Filter by class, section or student, pass one to that class teacher or subject teacher, see which the teacher has resolved, and tell the parent it is resolved.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'front_office.communication.parent_concerns' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
