-- +goose Up
-- Exam day: where a child sits, and the ticket that lets them in.
--
-- The exam module could schedule papers and record marks but had nothing in
-- between. A school running an SA still allocated halls on a whiteboard and
-- typed hall tickets in Word, which is the one document a candidate cannot sit
-- the paper without.

CREATE TABLE exam_halls (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE CASCADE,
    name            text        NOT NULL,
    -- Rows and columns rather than a flat capacity: a board exam seats
    -- candidates in a grid so invigilators can call a seat number, and
    -- capacity alone cannot produce "Row 3, Seat 4".
    rows_count      integer     NOT NULL DEFAULT 5,
    cols_count      integer     NOT NULL DEFAULT 6,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT exam_halls_grid CHECK (rows_count > 0 AND cols_count > 0),
    CONSTRAINT exam_halls_unique UNIQUE (institution_id, name)
);

CREATE TABLE exam_seats (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    exam_id         uuid        NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    hall_id         uuid        NOT NULL REFERENCES exam_halls(id) ON DELETE CASCADE,
    row_no          integer     NOT NULL,
    col_no          integer     NOT NULL,
    /* The number printed on the ticket and called at the door.

       Distinct from the admission number on purpose: a board exam identifies a
       candidate by a number that carries no information about who they are,
       so a paper cannot be recognised during marking. */
    ticket_no       text        NOT NULL,
    allocated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT exam_seats_position CHECK (row_no > 0 AND col_no > 0)
);

-- One candidate, one seat, one ticket. All three are separate mistakes and
-- each has its own index, so a bad allocation fails loudly rather than
-- producing two children at the same desk.
CREATE UNIQUE INDEX exam_seats_one_per_candidate ON exam_seats (exam_id, student_id);
CREATE UNIQUE INDEX exam_seats_one_per_desk ON exam_seats (exam_id, hall_id, row_no, col_no);
CREATE UNIQUE INDEX exam_seats_ticket ON exam_seats (institution_id, exam_id, ticket_no);

CREATE INDEX exam_seats_hall ON exam_seats (exam_id, hall_id);

ALTER TABLE exam_halls ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_halls FORCE ROW LEVEL SECURITY;
ALTER TABLE exam_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_seats FORCE ROW LEVEL SECURITY;

CREATE POLICY exam_halls_tenant ON exam_halls
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY exam_seats_tenant ON exam_seats
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS exam_seats;
DROP TABLE IF EXISTS exam_halls;
