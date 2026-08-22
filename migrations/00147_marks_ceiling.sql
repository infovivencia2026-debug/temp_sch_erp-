-- +goose Up
-- A mark of 50 on a paper out of 20.
--
-- The only constraint this table ever had was
-- CHECK (marks_obtained IS NULL OR marks_obtained >= 0), from the baseline.
-- Nothing tied a mark to its exam subject's max_marks — not the schema, not
-- the write path. So marks above the ceiling were stored, and then every
-- screen that divides by max_marks reported them faithfully: Performance
-- overview at 169% average, subject averages of 148-190%, a range to 250%,
-- and mark moderation listing papers out of 20 with marks up to 50.
--
-- None of those screens is wrong. Their arithmetic is right and their input
-- was impossible. Rounding or clamping in the UI would have hidden the only
-- evidence that the data was broken.
--
-- The API now rejects an over-ceiling mark by name and number. This is the
-- second line: a CHECK cannot reach exam_subjects, so it has to be a trigger.
-- The API has never been the only thing that writes here — the demo seeder
-- wrote these rows directly, and so does every psql session anybody has ever
-- opened against this database.

-- ---------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION marks_within_paper_maximum() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    ceiling numeric;
    total   numeric;
    paper   text;
BEGIN
    -- Not entered yet is not a violation; absence is recorded by is_absent and
    -- carries no mark to check.
    IF NEW.marks_obtained IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT es.max_marks, COALESCE(sub.name, 'this paper')
      INTO ceiling, paper
      FROM exam_subjects es
      LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id
      LEFT JOIN subjects sub      ON sub.id = cs.subject_id
     WHERE es.id = NEW.exam_subject_id;

    -- max_marks is NOT NULL on exam_subjects, but a paper that has somehow
    -- lost its maximum has no ceiling to enforce; refusing every mark on it
    -- would block entry outright, which is a worse failure than the one this
    -- trigger prevents.
    IF ceiling IS NULL OR ceiling <= 0 THEN
        RETURN NEW;
    END IF;

    -- grace_marks is counted in, because every reporting query adds it to
    -- marks_obtained before dividing by max_marks. A ceiling that ignored it
    -- would still allow 103%.
    total := NEW.marks_obtained + COALESCE(NEW.grace_marks, 0);

    IF total > ceiling THEN
        RAISE EXCEPTION
            '% is above the maximum for %: that paper is out of %',
            total, paper, ceiling
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS marks_ceiling ON marks;

CREATE TRIGGER marks_ceiling
    BEFORE INSERT OR UPDATE OF marks_obtained, grace_marks, exam_subject_id ON marks
    FOR EACH ROW EXECUTE FUNCTION marks_within_paper_maximum();

-- ---------------------------------------------------------------------------
-- What is already in there
-- ---------------------------------------------------------------------------
-- The trigger fires on write, so rows already stored are untouched by it and
-- stay exactly as they are. That is deliberate. Marks are a school's record of
-- what children scored; a migration that quietly divides them down would
-- destroy the only copy of the real number, and the school would find out at a
-- board-result appeal.
--
-- Instead: a view the operator can read, and act on with the teacher who has
-- the mark sheet. It also means an existing row can still be corrected — an
-- UPDATE that brings a mark under the ceiling passes the trigger, while one
-- that leaves it above does not, which is the direction you want.
CREATE OR REPLACE VIEW marks_over_paper_maximum AS
    SELECT m.institution_id,
           m.id AS mark_id,
           m.student_id,
           m.exam_subject_id,
           ex.name        AS exam,
           sub.name       AS subject,
           c.name         AS class,
           m.marks_obtained,
           m.grace_marks,
           es.max_marks,
           round(100.0 * (m.marks_obtained + COALESCE(m.grace_marks, 0))
                 / NULLIF(es.max_marks, 0), 1) AS percent_of_paper,
           m.entered_by,
           m.entered_at
      FROM marks m
      JOIN exam_subjects es       ON es.id = m.exam_subject_id
      LEFT JOIN exams ex          ON ex.id = es.exam_id
      LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id
      LEFT JOIN subjects sub      ON sub.id = cs.subject_id
      LEFT JOIN classes c         ON c.id = cs.class_id
     WHERE m.marks_obtained IS NOT NULL
       AND es.max_marks > 0
       AND m.marks_obtained + COALESCE(m.grace_marks, 0) > es.max_marks;

COMMENT ON VIEW marks_over_paper_maximum IS
    'Marks stored above their paper''s max_marks, from before 00146 added the '
    'marks_ceiling trigger. Nothing rewrites these: check each against the '
    'mark sheet and correct it. SELECT count(*) FROM marks_over_paper_maximum; '
    'is the number to watch, and it should only ever go down.';

-- The view is defined over marks, which has FORCE ROW LEVEL SECURITY: the
-- tenant policy applies to the table's owner too, so a view running with
-- owner rights still cannot read another school's rows. security_invoker is
-- belt to that braces, and is set only where it exists (PostgreSQL 15) so this
-- migration does not fail on an older server.
-- +goose StatementBegin
DO $$
BEGIN
    IF current_setting('server_version_num')::int >= 150000 THEN
        EXECUTE 'ALTER VIEW marks_over_paper_maximum SET (security_invoker = true)';
    END IF;
END $$;
-- +goose StatementEnd

GRANT SELECT ON marks_over_paper_maximum TO app_user;

-- The count is deliberately not raised as a NOTICE here: goose runs this
-- unattended at deploy and a notice scrolls past. The view is the report.

-- +goose Down
DROP VIEW IF EXISTS marks_over_paper_maximum;
DROP TRIGGER IF EXISTS marks_ceiling ON marks;
DROP FUNCTION IF EXISTS marks_within_paper_maximum();
