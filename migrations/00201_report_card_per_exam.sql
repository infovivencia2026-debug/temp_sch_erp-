-- +goose Up
-- A report card is for an examination.
--
-- Until now a card was keyed (student, academic_year): one card per child per
-- year, and nothing on it recorded which examination it was for. Three faults
-- fell out of that one omission, and every one of them was reported as a
-- separate bug.
--
--   Generating cards for a second exam overwrote the first. A school that ran
--   FA1, printed the cards, then ran FA2 did not get a second set -- it got
--   the first set silently replaced, with no record that FA1 had ever been
--   carded.
--
--   The subject table listed every paper the class had ever sat, because a
--   card had no exam to filter by.
--
--   The printed exam name was "the most recently created exam this year",
--   so creating a later exam renamed cards already printed for an earlier one.
--
-- exam_id is nullable on purpose. A school whose own report card covers the
-- whole year in one document -- which is how many schools print -- keeps a
-- card with no exam, and that card goes on showing everything in its term.
-- The default is one card per exam; the year-wide card remains possible.
ALTER TABLE report_cards ADD COLUMN IF NOT EXISTS exam_id uuid REFERENCES exams(id) ON DELETE SET NULL;

-- One card per child per exam. Partial, because the year-wide cards above
-- carry no exam and must not collide with each other on a NULL.
CREATE UNIQUE INDEX IF NOT EXISTS report_cards_student_exam_key
    ON report_cards (student_id, exam_id) WHERE exam_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS report_cards_exam_idx ON report_cards (exam_id);

-- Existing cards, where the answer is not a guess: a year holding exactly one
-- exam has only one exam the card can be for. A year with two or more is left
-- null rather than assigned, because assigning it to either would be inventing
-- a fact -- and a null card still renders exactly as it does today.
UPDATE report_cards rc
   SET exam_id = (SELECT ex.id FROM exams ex
                   WHERE ex.academic_year_id = rc.academic_year_id
                     AND ex.institution_id = rc.institution_id
                   LIMIT 1)
 WHERE rc.exam_id IS NULL
   AND (SELECT count(*) FROM exams ex
         WHERE ex.academic_year_id = rc.academic_year_id
           AND ex.institution_id = rc.institution_id) = 1;

-- +goose Down
DROP INDEX IF EXISTS report_cards_student_exam_key;
DROP INDEX IF EXISTS report_cards_exam_idx;
ALTER TABLE report_cards DROP COLUMN IF EXISTS exam_id;
