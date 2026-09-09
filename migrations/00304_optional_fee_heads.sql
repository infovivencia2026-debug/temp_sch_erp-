-- +goose Up

-- A fee only the children who chose it owe.
--
-- The structure prices a class and the demand run bills every child in it, so
-- a head on the structure is owed by everybody in that class. That is right
-- for tuition and wrong for the activities a family opts into: after-school
-- ECA, music, a coaching batch, the second language nobody is required to
-- take. A school that lists ECA on the structure bills the whole grade for it
-- and then unpicks the ones who never signed up, invoice by invoice.
--
-- fee_heads.service already carries this shape for two cases -- transport is
-- owed by taking the bus, hostel by living in -- but it is a closed list of
-- exactly those two, and both are priced per child from something else (a
-- stop, a bed) through student_fee_components. An activity is not: it is on
-- the structure at the structure's price, and the only question is who takes
-- it.
--
-- So: a flag on the head, and a row per child who chose it.
--
-- NOTHING CHANGES UNTIL A SCHOOL SAYS SO. optional defaults to false, so every
-- head that exists today is owed by everybody exactly as it was, and the
-- demand run's new clause is inert until somebody ticks a box. That is
-- deliberate: this is the billing path, and a migration that silently stops
-- charging for something would be discovered at the end of a term.

ALTER TABLE fee_heads
    ADD COLUMN IF NOT EXISTS optional boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN fee_heads.optional IS
    'True when only the children who chose this head owe it. See student_fee_optins.';

-- Who chose it.
--
-- Per year, because a child takes ECA in Grade 6 and drops it in Grade 7, and
-- last year's invoices have to stay explicable. Ended by ended_on rather than
-- deleted, for the reason student_fee_components are: a charge already raised
-- must remain traceable to the choice that caused it.
CREATE TABLE IF NOT EXISTS student_fee_optins (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id)   ON DELETE CASCADE,
    student_id       uuid NOT NULL REFERENCES students(id)       ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    -- RESTRICT like every other reference to a head: one with money charged
    -- under it is not deletable.
    fee_head_id      uuid NOT NULL REFERENCES fee_heads(id)      ON DELETE RESTRICT,
    chosen_on        date NOT NULL DEFAULT CURRENT_DATE,
    ended_on         date,
    note             text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_fee_optins_window CHECK (ended_on IS NULL OR ended_on >= chosen_on)
);

-- One live choice per child per head per year. Re-joining after leaving ends
-- the old row and writes a new one; two live rows would say nothing extra and
-- would make "is this child in ECA" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS student_fee_optins_one_live
    ON student_fee_optins (student_id, fee_head_id, academic_year_id)
 WHERE ended_on IS NULL;

CREATE INDEX IF NOT EXISTS student_fee_optins_head
    ON student_fee_optins (institution_id, fee_head_id, academic_year_id);

ALTER TABLE student_fee_optins ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_optins FORCE  ROW LEVEL SECURITY;
CREATE POLICY student_fee_optins_tenant ON student_fee_optins
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

GRANT SELECT, INSERT, UPDATE, DELETE ON student_fee_optins TO app_user;

-- +goose Down
DROP TABLE IF EXISTS student_fee_optins;
ALTER TABLE fee_heads DROP COLUMN IF EXISTS optional;
