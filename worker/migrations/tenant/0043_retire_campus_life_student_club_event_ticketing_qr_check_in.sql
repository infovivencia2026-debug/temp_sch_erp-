-- 0043_retire_campus_life_student_club_event_ticketing_qr_check_in (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Retires campus_life.student_club_event_ticketing_qr_check_in (campus_life.student_club_event_ticketing_qr_check_in), written by `npm run feature:remove` (scripts/feature.mjs).
-- Takes the navigation and capability keys out of every school database.

DELETE FROM role_permissions WHERE permission_key = 'student.campus_life.student_club_event_ticketing_qr_check_in';
DELETE FROM user_permissions WHERE permission_key = 'student.campus_life.student_club_event_ticketing_qr_check_in';
DELETE FROM permissions WHERE key = 'student.campus_life.student_club_event_ticketing_qr_check_in';
