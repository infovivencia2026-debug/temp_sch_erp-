-- +goose Up
-- report_cards_student_id_academic_year_id_term_id_key is UNIQUE over
-- (student_id, academic_year_id, term_id) and term_id is nullable. A term-less
-- report card — an annual one — therefore never conflicts with itself, because
-- Postgres treats NULLs as distinct. Re-running generation would silently
-- insert a second card for the same child instead of updating the first.
--
-- Same failure mode as numbering_schemes in 00004. A partial unique index over
-- the non-null columns closes it and gives the upsert a target to match.
CREATE UNIQUE INDEX IF NOT EXISTS report_cards_student_year_annual
    ON report_cards (student_id, academic_year_id) WHERE term_id IS NULL;

-- +goose Down
DROP INDEX IF EXISTS report_cards_student_year_annual;
