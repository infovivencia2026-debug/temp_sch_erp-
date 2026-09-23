-- +goose NO TRANSACTION
-- +goose Up

-- THE AUDIT TRAIL IS READ NEWEST-FIRST BY ID, AND HAD NO INDEX FOR IT.
--
-- listAudit orders by id DESC and pages by id; the only tenant index was on
-- created_at DESC, which the planner cannot substitute. On the largest table
-- in the schema -- every write, with up to 64 KiB of body each -- that was a
-- sort of the whole thing per page.
--
-- CONCURRENTLY, and this file outside a transaction because Postgres
-- requires it: the migrate job runs while the old revision is still
-- serving, and a plain CREATE INDEX on this table would block every write on
-- the platform for the duration of the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_institution_id_id_idx
    ON audit_log (institution_id, id DESC);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS audit_log_institution_id_id_idx;
