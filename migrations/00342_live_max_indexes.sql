-- +goose NO TRANSACTION
-- +goose Up
-- /portal/live asks seven tables for their latest timestamp every thirty
-- seconds per open tab. max() over an unindexed column is a full scan; over
-- a (institution_id, column DESC) index it is one probe, and the tenant column
-- leads because row-level security adds it to every query. CONCURRENTLY, and
-- outside a transaction, so the migrate job never blocks the revision that is
-- still serving.
CREATE INDEX CONCURRENTLY IF NOT EXISTS student_attendance_live_idx ON student_attendance (institution_id, marked_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS student_attendance_corrected_live_idx ON student_attendance (institution_id, corrected_at DESC) WHERE corrected_at IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS marks_live_idx ON marks (institution_id, entered_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS invoices_live_idx ON invoices (institution_id, updated_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS homework_live_idx ON homework (institution_id, updated_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS report_cards_live_idx ON report_cards (institution_id, published_at DESC) WHERE is_published;
CREATE INDEX CONCURRENTLY IF NOT EXISTS fee_concessions_live_idx ON fee_concessions (institution_id, decided_at DESC);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS fee_concessions_live_idx;
DROP INDEX CONCURRENTLY IF EXISTS report_cards_live_idx;
DROP INDEX CONCURRENTLY IF EXISTS homework_live_idx;
DROP INDEX CONCURRENTLY IF EXISTS invoices_live_idx;
DROP INDEX CONCURRENTLY IF EXISTS marks_live_idx;
DROP INDEX CONCURRENTLY IF EXISTS student_attendance_corrected_live_idx;
DROP INDEX CONCURRENTLY IF EXISTS student_attendance_live_idx;
