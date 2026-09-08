-- +goose Up

/* A report card knows which term it is for.
 *
 * generateReportCards never wrote term_id. Every card it produced was, as far
 * as the table could tell, the year's card: the family screen labelled it with
 * the year's name, the "annual card" lookups matched every one of them, and
 * the remark the class teacher wrote for the term (which IS keyed by term)
 * landed on a different row that carried no marks. One row with numbers and
 * no words, another with words and no numbers.
 *
 * The card takes its term from its exam. The old UNIQUE (student, year, term)
 * has to go for that: two exams in one term -- FA1 and FA2 both in Term 1 --
 * each get their own card (that is 00201's rule), and both now say Term 1.
 * What is left unique is the remark-only row, one per child per term, which
 * exists only until the term's card is generated and adopts it. */

SELECT set_config('app.is_platform_admin', 'on', true);

ALTER TABLE report_cards
    DROP CONSTRAINT IF EXISTS report_cards_student_id_academic_year_id_term_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS report_cards_student_year_term_remarks_key
    ON report_cards (student_id, academic_year_id, term_id)
 WHERE exam_id IS NULL AND term_id IS NOT NULL;

-- Cards already generated: the term is their exam's term.
UPDATE report_cards rc
   SET term_id = e.term_id
  FROM exams e
 WHERE e.id = rc.exam_id
   AND rc.term_id IS NULL
   AND e.term_id IS NOT NULL;

/* The two halves, joined where the join is not a guess.
 *
 * A remark-only row and an exam card for the same child and term: the words
 * go onto the card that has the numbers, and the row that only ever held the
 * words is removed. Only when the term has exactly one card, because with two
 * there is no saying which paper the teacher was writing about. */
-- +goose StatementBegin
DO $$
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);

    WITH words AS (
        SELECT w.id AS words_id, c.id AS card_id
          FROM report_cards w
          JOIN LATERAL (
                SELECT c.id FROM report_cards c
                 WHERE c.student_id = w.student_id
                   AND c.academic_year_id = w.academic_year_id
                   AND c.term_id = w.term_id
                   AND c.exam_id IS NOT NULL
               ) c ON true
         WHERE w.exam_id IS NULL AND w.term_id IS NOT NULL
           AND w.total_marks IS NULL
           AND (SELECT count(*) FROM report_cards c2
                 WHERE c2.student_id = w.student_id
                   AND c2.academic_year_id = w.academic_year_id
                   AND c2.term_id = w.term_id
                   AND c2.exam_id IS NOT NULL) = 1
    ),
    moved AS (
        UPDATE report_cards c
           SET class_teacher_remarks    = COALESCE(c.class_teacher_remarks, w.class_teacher_remarks),
               class_teacher_remarks_by = COALESCE(c.class_teacher_remarks_by, w.class_teacher_remarks_by),
               class_teacher_remarks_at = COALESCE(c.class_teacher_remarks_at, w.class_teacher_remarks_at),
               principal_remarks        = COALESCE(c.principal_remarks, w.principal_remarks),
               principal_remarks_by     = COALESCE(c.principal_remarks_by, w.principal_remarks_by),
               principal_remarks_at     = COALESCE(c.principal_remarks_at, w.principal_remarks_at)
          FROM words x
          JOIN report_cards w ON w.id = x.words_id
         WHERE c.id = x.card_id
        RETURNING x.words_id
    )
    DELETE FROM report_cards WHERE id IN (SELECT words_id FROM moved);
END $$;
-- +goose StatementEnd

-- +goose Down
DROP INDEX IF EXISTS report_cards_student_year_term_remarks_key;
-- The old constraint cannot come back while two exams in one term each have
-- a card; the terms written above are facts and stay.
SELECT 1;
