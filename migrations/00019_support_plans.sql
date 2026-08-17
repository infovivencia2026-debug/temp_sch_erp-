-- +goose Up
-- The classroom accommodations agreed for a child who needs them.
--
-- students already carries is_cwsn and cwsn_type, so the product could say a
-- child has a hearing impairment and nothing about what the school agreed to
-- do about it. The label without the plan is the part that fails an RPWD Act
-- inspection, and more to the point it is the part a substitute teacher
-- needs on the morning they walk into the room.

CREATE TABLE student_support_plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- What the child finds hard, in the school's own words. Deliberately not a
    -- code list: the disability category lives on students.cwsn_type, and this
    -- is the sentence a teacher actually reads.
    concern         text        NOT NULL,
    -- The accommodations, one per line. Free text because "seat him at the
    -- front, left ear to the class, and give the worksheet in advance" is not
    -- expressible as a checkbox, and a checkbox version would be ignored.
    accommodations  text        NOT NULL,
    -- Exam concessions are a separate legal question from classroom ones: a
    -- scribe or extra time has to be applied for from the board, and a school
    -- that conflates them discovers the difference in February.
    exam_concession text,
    -- Who outside the school is involved: a therapist, a district resource
    -- centre, a paediatrician.
    external_support text,
    -- A plan with no review date becomes a plan nobody revisits. Nullable
    -- because a school entering its first plans should not be blocked on
    -- choosing one, but the screen asks.
    review_on       date,
    status          text        NOT NULL DEFAULT 'active',
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_support_plans_status
        CHECK (status IN ('active', 'review_due', 'closed')),
    CONSTRAINT student_support_plans_closed_is_dated
        CHECK (status <> 'closed' OR review_on IS NOT NULL)
);

-- One active plan per child. A child may have had an earlier plan that was
-- closed, and the history is worth keeping, but two live plans means two
-- teachers are working from different instructions.
CREATE UNIQUE INDEX student_support_plans_one_active
    ON student_support_plans (student_id)
 WHERE status <> 'closed';

CREATE INDEX student_support_plans_review
    ON student_support_plans (institution_id, review_on)
 WHERE status <> 'closed';

ALTER TABLE student_support_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_support_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY student_support_plans_tenant ON student_support_plans
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- discipline_records was created with the schema and never wired to anything.
-- Two indexes it needs now that it is about to hold rows: a child's own
-- history, and the school's recent conduct log.
CREATE INDEX IF NOT EXISTS discipline_records_student
    ON discipline_records (student_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS discipline_records_recent
    ON discipline_records (institution_id, occurred_on DESC);

-- +goose Down
DROP TABLE IF EXISTS student_support_plans;
DROP INDEX IF EXISTS discipline_records_student;
DROP INDEX IF EXISTS discipline_records_recent;
