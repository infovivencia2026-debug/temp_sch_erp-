-- +goose Up

--  A child can change section in the middle of the year.
--
-- enrollments was UNIQUE on (student, academic_year): one row per child per
-- year, for ever. So the mid-year move -- 5-A to 5-B in October, the most
-- ordinary request a school office gets -- had no honest shape. The move
-- endpoint rewrote the row in place, which erased where the child had been;
-- and promotion, the other route, closed the row as 'promoted' and then hit
-- the constraint with ON CONFLICT DO NOTHING, leaving the child with no
-- active enrolment at all: off the roster, the gradebook, the invoice run.
--
-- What is actually unique is one ACTIVE enrolment per child per year. The
-- closed rows are history and there may be several of them. 

SELECT set_config('app.is_platform_admin', 'on', true);

ALTER TABLE enrollments
    DROP CONSTRAINT IF EXISTS enrollments_student_id_academic_year_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_active_per_year
    ON enrollments (student_id, academic_year_id)
 WHERE status = 'active';

ALTER TABLE enrollments
    -- The day the row stopped being where the child sits. NULL while active;
    -- the attendance and marks taken before it stay against this row.
    ADD COLUMN IF NOT EXISTS ended_on date;

-- 'moved' is how a mid-year section change ends a row. The others each say
-- something else: promoted (next year), transferred (left the school).
ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check
    CHECK (status IN ('active','promoted','detained','transferred','withdrawn','completed','moved'));

-- +goose Down
ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check
    CHECK (status IN ('active','promoted','detained','transferred','withdrawn','completed'));
ALTER TABLE enrollments DROP COLUMN IF EXISTS ended_on;
DROP INDEX IF EXISTS enrollments_one_active_per_year;
-- The old constraint is not restored: a child who has moved section has two
-- rows for the year, and both are true.
