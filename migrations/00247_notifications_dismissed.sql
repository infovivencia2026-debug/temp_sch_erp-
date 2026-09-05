-- +goose Up
-- Clearing the feed, without forgetting what was in it.
--
-- "Clear" cannot be a DELETE: the family alerts are re-materialised from the
-- circulars, registers, bills and homework they describe on every read, with
-- ON CONFLICT DO NOTHING against the rows that exist. Delete a row and the
-- next poll writes it back. A dismissed mark leaves the row where the
-- conflict can see it and takes it out of the feed.
ALTER TABLE notifications ADD COLUMN dismissed_at timestamptz;
CREATE INDEX notifications_user_live_idx
    ON notifications (user_id, created_at DESC) WHERE dismissed_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS notifications_user_live_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS dismissed_at;
