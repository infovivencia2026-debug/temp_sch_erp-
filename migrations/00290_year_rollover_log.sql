-- +goose Up
-- What the year rollover has already carried into a year.
--
-- Every April the office rebuilt next year's sections, fee structure,
-- transport allocations and timetable by hand, because nothing in the product
-- would copy them. The rollover endpoint now does, and the danger of a copy is
-- that it runs twice: a principal who is not sure the first click took clicks
-- again, and 2027-28 has two of every section. A unique row per (target year,
-- item) is what makes the second click a no-op rather than a duplicate -- the
-- endpoint inserts here before it copies, inside the same transaction, so a
-- copy that failed half way leaves no row and can be rerun.
--
-- Keyed on the target year and not the pair, because a year can only be
-- filled from one source: sections copied from 2025-26 and again from 2026-27
-- would collide on the (class, year, name) key anyway.
CREATE TABLE rollover_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    source_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    target_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    -- sections | fee_structure | transport | timetable
    item            text NOT NULL,
    copied          integer NOT NULL DEFAULT 0,
    run_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    run_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rollover_log_item CHECK (item IN ('sections', 'fee_structure', 'transport', 'hostel', 'timetable', 'subjects')),
    CONSTRAINT rollover_log_copied CHECK (copied >= 0),
    CONSTRAINT rollover_log_direction CHECK (source_year_id <> target_year_id),
    UNIQUE (target_year_id, item)
);
CREATE INDEX rollover_log_institution ON rollover_log (institution_id, target_year_id);

ALTER TABLE rollover_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollover_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY rollover_log_tenant ON rollover_log
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON rollover_log TO app_user;

-- +goose Down
DROP TABLE IF EXISTS rollover_log;
