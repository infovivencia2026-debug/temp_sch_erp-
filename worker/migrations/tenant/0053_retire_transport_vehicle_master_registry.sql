-- 0053_retire_transport_vehicle_master_registry (tenant: every school database).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Retires transport.vehicle_master_registry (transport.vehicle_master_registry), written by `npm run feature:remove` (scripts/feature.mjs).
-- Takes the navigation and capability keys out of every school database.

DELETE FROM role_permissions WHERE permission_key = 'transport_manager.transport.vehicle_master_registry';
DELETE FROM user_permissions WHERE permission_key = 'transport_manager.transport.vehicle_master_registry';
DELETE FROM permissions WHERE key = 'transport_manager.transport.vehicle_master_registry';
