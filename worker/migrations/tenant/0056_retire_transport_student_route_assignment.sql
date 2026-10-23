-- 0056_retire_transport_student_route_assignment (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Retires transport.student_route_assignment (transport.student_route_assignment), written by `npm run feature:remove` (scripts/feature.mjs).
-- Takes the navigation and capability keys out of every school database.

DELETE FROM role_permissions WHERE permission_key = 'transport_manager.transport.student_route_assignment';
DELETE FROM user_permissions WHERE permission_key = 'transport_manager.transport.student_route_assignment';
DELETE FROM permissions WHERE key = 'transport_manager.transport.student_route_assignment';
