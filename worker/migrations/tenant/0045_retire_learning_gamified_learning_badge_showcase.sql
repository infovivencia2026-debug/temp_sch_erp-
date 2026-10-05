-- 0045_retire_learning_gamified_learning_badge_showcase (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Retires learning.gamified_learning_badge_showcase (learning.gamified_learning_badge_showcase), written by `npm run feature:remove` (scripts/feature.mjs).
-- Takes the navigation and capability keys out of every school database.

DELETE FROM role_permissions WHERE permission_key = 'student.learning.gamified_learning_badge_showcase';
DELETE FROM user_permissions WHERE permission_key = 'student.learning.gamified_learning_badge_showcase';
DELETE FROM permissions WHERE key = 'student.learning.gamified_learning_badge_showcase';
