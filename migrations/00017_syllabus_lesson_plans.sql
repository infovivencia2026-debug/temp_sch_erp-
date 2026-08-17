-- +goose Up
-- The syllabus, the lesson plans that deliver it, and how far through a class is.
--
-- The product could say a class studies Mathematics and nothing about what
-- Mathematics contains, so "are we behind?" — the question a principal asks
-- every fortnight and a board inspection asks once a year — had no answer
-- except a teacher's diary.
--
-- Three tables and one derived number. Units are the chapters; a lesson plan
-- says which units a period will cover and goes through approval; coverage is
-- units with a delivered plan over units planned. Coverage is computed rather
-- than stored, because a stored percentage is wrong the moment a unit is added
-- and nobody remembers to recompute it.

CREATE TABLE syllabus_units (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    class_subject_id uuid       NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    sequence        integer     NOT NULL DEFAULT 0,
    title           text        NOT NULL,
    description     text,
    -- What the syllabus allows. The gap between this and periods actually
    -- spent is the earliest signal that a class is running behind.
    planned_periods integer     NOT NULL DEFAULT 1,
    -- NCERT learning outcomes, one per line. NEP asks schools to plan against
    -- outcomes rather than chapter names; storing them here means a lesson
    -- plan can cite them without a second vocabulary.
    outcomes        text,
    term_id         uuid        REFERENCES terms(id) ON DELETE SET NULL,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT syllabus_units_periods CHECK (planned_periods > 0)
);

CREATE INDEX syllabus_units_subject ON syllabus_units (class_subject_id, sequence);

/* A lesson plan.

   Scoped to a section rather than a class: 8-A and 8-B are taught by different
   people at different speeds, and a plan shared between them cannot record
   that one is two chapters behind.

   status is a small workflow, not a boolean. A plan that was returned with
   remarks is not the same as one never submitted, and a head of department
   reviewing forty of them needs to see which are which. */
CREATE TABLE lesson_plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id      uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    class_subject_id uuid       NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    teacher_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- The week the plan is for. A date rather than a week number: week 32 of
    -- which year, counted from when, is a question nobody should have to ask.
    week_of         date        NOT NULL,
    objectives      text,
    activities      text,
    resources       text,
    homework        text,
    status          text        NOT NULL DEFAULT 'draft',
    submitted_at    timestamptz,
    reviewed_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     timestamptz,
    remarks         text,
    -- Set when the lesson actually happened, which is what advances coverage.
    -- Distinct from approved: a plan can be approved and then not taught
    -- because the school closed for rain.
    delivered_on    date,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lesson_plans_status
        CHECK (status IN ('draft','submitted','approved','returned')),
    -- A returned plan without remarks tells the teacher nothing.
    CONSTRAINT lesson_plans_returned_has_remarks
        CHECK (status <> 'returned' OR nullif(btrim(remarks), '') IS NOT NULL)
);

-- One plan per section, subject and week. A teacher revising their plan edits
-- it; two plans for the same week is a mistake, not a revision.
CREATE UNIQUE INDEX lesson_plans_one_per_week
    ON lesson_plans (section_id, class_subject_id, week_of);

CREATE INDEX lesson_plans_review_queue ON lesson_plans (institution_id, status, submitted_at)
 WHERE status = 'submitted';

-- Which units a plan covers. A week rarely maps to exactly one chapter, and a
-- chapter often spans three weeks, so this is many-to-many rather than a
-- column on either side.
CREATE TABLE lesson_plan_units (
    lesson_plan_id  uuid NOT NULL REFERENCES lesson_plans(id) ON DELETE CASCADE,
    syllabus_unit_id uuid NOT NULL REFERENCES syllabus_units(id) ON DELETE CASCADE,
    PRIMARY KEY (lesson_plan_id, syllabus_unit_id)
);

ALTER TABLE syllabus_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE syllabus_units FORCE ROW LEVEL SECURITY;
ALTER TABLE lesson_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY syllabus_units_tenant ON syllabus_units
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY lesson_plans_tenant ON lesson_plans
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- lesson_plan_units carries no institution_id of its own; both its parents are
-- tenant-scoped and it cascades from them, so a row cannot outlive its plan.
ALTER TABLE lesson_plan_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_plan_units FORCE ROW LEVEL SECURITY;
CREATE POLICY lesson_plan_units_tenant ON lesson_plan_units
    USING (EXISTS (SELECT 1 FROM lesson_plans lp
                    WHERE lp.id = lesson_plan_id
                      AND (lp.institution_id = app_current_institution()
                           OR app_is_platform_admin())))
    WITH CHECK (EXISTS (SELECT 1 FROM lesson_plans lp
                         WHERE lp.id = lesson_plan_id
                           AND (lp.institution_id = app_current_institution()
                                OR app_is_platform_admin())));

-- +goose Down
DROP TABLE IF EXISTS lesson_plan_units;
DROP TABLE IF EXISTS lesson_plans;
DROP TABLE IF EXISTS syllabus_units;
