-- +goose Up
-- A picture for the price list.
--
-- The store already knows a product's name, category and price; what it could
-- not show a parent browsing the catalogue is what the thing looks like. This
-- adds one nullable column holding a files.id (the same key avatar_key and
-- logo_key hold), served through /api/v1/files/{id} like every other image in
-- the app. Nullable, because most rows will never carry one and a shirt with
-- no photo is still a shirt on the shelf.
ALTER TABLE store_products ADD COLUMN IF NOT EXISTS image_key text;

-- +goose Down
ALTER TABLE store_products DROP COLUMN IF EXISTS image_key;
