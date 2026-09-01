-- +goose Up

-- Art, games, discipline: the half of a report card that has no marks.
--
-- Every board asks for it and the product had nowhere to put it. CBSE mandates
-- co-scholastic assessment outright; state boards ask for conduct and work
-- education. So a school graded Art and Physical Education on paper, typed
-- them into the report card by hand at the end of term, and had no record of
-- them anywhere afterwards. Ask what a child got for Discipline last year and
-- the answer was in a cupboard.
--
-- It is NOT a subject and must not be modelled as one. A subject has marks
-- out of a paper, a syllabus, a teacher allocation and a place in the
-- timetable. Art as a co-scholastic area has a grade, a term, and a sentence.
-- Forcing it into class_subjects would put it in the timetable, into the
-- allocation grid, and into every percentage the report card computes, where
-- it does not belong: a child with an A in Discipline has not scored anything.
--
-- THE AREAS ARE THE SCHOOL'S, not ours. CBSE's list is not Kerala's and
-- neither is a school that also grades Music. Seeded with the common ones so
-- the screen is not empty on day one, and every one of them editable.

CREATE TABLE IF NOT EXISTS co_scholastic_areas (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    name           text NOT NULL,
    -- Ordered as the report card prints them, not alphabetically: a school
    -- puts Discipline last on purpose.
    sequence       int  NOT NULL DEFAULT 0,
    -- Wound up rather than deleted, so grades already given keep reading.
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS co_scholastic_areas_name
    ON co_scholastic_areas (institution_id, lower(name));

CREATE TABLE IF NOT EXISTS co_scholastic_grades (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    area_id        uuid NOT NULL REFERENCES co_scholastic_areas(id) ON DELETE RESTRICT,
    term_id        uuid REFERENCES terms(id) ON DELETE SET NULL,
    -- A letter, a word, whatever the school grades in: A/B/C, Excellent, 5.
    -- Deliberately free text against the school's own scale rather than a
    -- number, because co-scholastic assessment is not arithmetic and storing
    -- it as one invites somebody to average it into a percentage.
    grade          text NOT NULL,
    -- The sentence a parent actually reads at a parents evening.
    remark         text,
    graded_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    graded_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT co_scholastic_grade_present
        CHECK (nullif(btrim(grade), '') IS NOT NULL)
);

-- One grade per child per area per term. A second is a correction, so the
-- write is an upsert rather than an insert and this index is what makes it
-- one.
CREATE UNIQUE INDEX IF NOT EXISTS co_scholastic_grades_once
    ON co_scholastic_grades (student_id, area_id, COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS co_scholastic_grades_by_student
    ON co_scholastic_grades (student_id);

ALTER TABLE co_scholastic_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_scholastic_areas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON co_scholastic_areas;
CREATE POLICY tenant_isolation ON co_scholastic_areas
    USING (app_is_platform_admin() OR institution_id = app_current_institution());

ALTER TABLE co_scholastic_grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_scholastic_grades FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON co_scholastic_grades;
CREATE POLICY tenant_isolation ON co_scholastic_grades
    USING (app_is_platform_admin() OR institution_id = app_current_institution());

-- The common areas, so the screen is not empty on the first day. Every one is
-- editable and any school can wind them up and write its own.
-- +goose StatementBegin
DO $$
DECLARE inst uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        INSERT INTO co_scholastic_areas (institution_id, name, sequence)
        VALUES (inst, 'Work Education',      10),
               (inst, 'Art Education',       20),
               (inst, 'Health and Physical Education', 30),
               (inst, 'Discipline',          40)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS co_scholastic_grades;
DROP TABLE IF EXISTS co_scholastic_areas;
