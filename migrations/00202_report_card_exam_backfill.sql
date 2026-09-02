-- +goose Up
-- The backfill in 00201, which ran and matched nothing.
--
-- Every table here has FORCE ROW LEVEL SECURITY, and a migration runs as the
-- application user with no app.institution_id set. So the UPDATE was filtered
-- to the rows of no institution at all: it reported success, changed nothing,
-- and left every existing card without the exam it was written to carry.
--
-- Exactly the failure this codebase keeps producing -- a statement that is
-- correct in isolation and silently scoped to nothing -- and the fix is the
-- one 00174 already established: say so explicitly, for the length of the
-- statement only.
--
-- Still only where the answer is not a guess. A year holding exactly one exam
-- has only one exam its cards can be for. A year with two or more is left
-- null, because choosing either would be inventing a fact, and a card with no
-- exam renders correctly anyway -- it is the school's year-wide card.

-- +goose StatementBegin
DO $$
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);

    UPDATE report_cards rc
       SET exam_id = (SELECT ex.id FROM exams ex
                       WHERE ex.academic_year_id = rc.academic_year_id
                         AND ex.institution_id = rc.institution_id
                       LIMIT 1)
     WHERE rc.exam_id IS NULL
       AND (SELECT count(*) FROM exams ex
             WHERE ex.academic_year_id = rc.academic_year_id
               AND ex.institution_id = rc.institution_id) = 1;

    RAISE NOTICE 'report cards given their exam: %', (
        SELECT count(*) FROM report_cards WHERE exam_id IS NOT NULL);
END $$;
-- +goose StatementEnd

-- +goose Down
-- Nothing: undoing this would take an exam off a card that is correctly on it.
SELECT 1;
