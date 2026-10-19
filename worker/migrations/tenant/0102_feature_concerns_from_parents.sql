-- 0102_feature_concerns_from_parents (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Concerns from parents (communication.concerns_from_parents), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('faculty.communication.concerns_from_parents', 'faculty', 'Concerns the front desk has passed to you about your classes. Read them and mark each one resolved; the front desk then tells the parent.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'faculty.communication.concerns_from_parents' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
