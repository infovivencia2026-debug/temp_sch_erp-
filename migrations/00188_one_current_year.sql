-- +goose Up

-- Two academic years were current at once, and nothing stopped them.
--
-- Every query that needs "this year" asks the same question:
--
--   SELECT id FROM academic_years WHERE is_current LIMIT 1
--
-- With two rows matching, LIMIT 1 returns whichever Postgres reaches first.
-- That is not stable between statements, so two code paths in the same
-- afternoon can resolve "this year" to two different years. Everything
-- downstream then quietly disagrees:
--
--   the guard that stops a child being invoiced twice compares
--   i.academic_year_id to the year it resolved, so a second run under the
--   other year does not see the first invoice and raises another. One child
--   on this deployment has three invoices for instalment 1;
--
--   the concession the invoice lines look up is matched on academic_year_id
--   as well, so an approved waiver on one year is invisible while billing
--   under the other. All three of that child's invoices carry a discount of
--   nought against an approved concession of two thousand rupees;
--
--   and the balance shown on the record sums the current year, so it can
--   total the year with no invoices in it and report "nothing due" to a
--   family owing twenty-three thousand.
--
-- One fault, three symptoms, none of which points at it.
--
-- WHICH YEAR SURVIVES
--
-- The one with the most invoices against it, then the most enrolments, then
-- the oldest. Invoices first because money already collected is the hardest
-- thing to move: an enrolment can be re-pointed at another year, a receipted
-- payment cannot. This is a tie-break rule and not a judgement about which
-- year a school meant; it only has to be deterministic and to protect the
-- rows that matter most.

-- +goose StatementBegin
DO $$
DECLARE
    inst uuid;
    keep uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT DISTINCT institution_id FROM academic_years WHERE is_current LOOP
        SELECT ay.id INTO keep
          FROM academic_years ay
         WHERE ay.institution_id = inst AND ay.is_current
         ORDER BY (SELECT count(*) FROM invoices i WHERE i.academic_year_id = ay.id) DESC,
                  (SELECT count(*) FROM enrollments e WHERE e.academic_year_id = ay.id) DESC,
                  ay.created_at
         LIMIT 1;

        UPDATE academic_years
           SET is_current = false
         WHERE institution_id = inst AND is_current AND id <> keep;
    END LOOP;
END $$;
-- +goose StatementEnd

-- One current year per school, enforced rather than assumed.
--
-- A partial unique index is the whole fix: the state cannot recur, and the
-- code that sets a year current has to clear the old one first, which is what
-- it should always have done.
CREATE UNIQUE INDEX IF NOT EXISTS academic_years_one_current
    ON academic_years (institution_id) WHERE is_current;

COMMENT ON INDEX academic_years_one_current IS
    'At most one current year per school. Every "this year" lookup is '
    'SELECT ... WHERE is_current LIMIT 1, which returns an arbitrary row when '
    'two match, so two code paths can resolve different years in one request.';

-- +goose Down

-- Deliberately empty. Dropping the index would allow the state back, and the
-- rows it corrected were never one anybody chose.
SELECT 1;
