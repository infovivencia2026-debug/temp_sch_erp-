-- 0038_retire_alumni_alumni_network_registration (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Retires alumni.alumni_network_registration (alumni.alumni_network_registration), written by `npm run feature:remove` (scripts/feature.mjs).
-- Takes the navigation and capability keys out of every school database.

DELETE FROM role_permissions WHERE permission_key = 'student.alumni.alumni_network_registration';
DELETE FROM user_permissions WHERE permission_key = 'student.alumni.alumni_network_registration';
DELETE FROM permissions WHERE key = 'student.alumni.alumni_network_registration';
