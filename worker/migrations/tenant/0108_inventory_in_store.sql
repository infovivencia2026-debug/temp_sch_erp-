-- 0108_inventory_in_store (tenant: every school database).
-- One list for the store (Yajur, 2026-10-22): an item on the stores register
-- can also be sold in the parent store, at its own selling price. Parents see
-- whether it is in stock, never the count.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE "inventory_items" ADD COLUMN "sale_price_paise" INTEGER;
ALTER TABLE "inventory_items" ADD COLUMN "in_store" INTEGER NOT NULL DEFAULT 0;

-- Why a parent saw no Store in the menu: the catalogue key was in the code's
-- parent role but no migration ever gave it to an existing school, so their
-- parent role did not hold it. A school that customised the role keeps that.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('parent.store.product_catalogue', 'parent', 'The school store, to browse, uniforms, books, stationery and sports items with their prices and whether they are in stock. Display only; buy at the school counter.');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'parent.store.product_catalogue' FROM roles WHERE key = 'parent' AND is_system = 1 AND customised_at IS NULL;
