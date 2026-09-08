-- +goose Up

-- A charge that belongs to one child rather than to a class.
--
-- The fee structure prices a class: every child in Grade 6 owes the same
-- tuition, the same lab fee, the same exam fee. The bus is not like that. A
-- child who boards at the far stop owes more than one who boards near the
-- school, and the child who walks owes nothing -- and there was nowhere to
-- write that down. allocateTransport worked out the fare from the stop and
-- handed it back to the screen, and the demand run copied the class's lines
-- and never asked. A bus child and a walking child got the same bill, and
-- the transport money was collected in a notebook.
--
-- One row per live charge per child. The allocation that caused it is kept
-- as source_kind/source_id so the line on the invoice can be traced back to
-- the stop it was priced from; the amount is copied rather than joined,
-- because a stop that is repriced in October must not silently restate the
-- June invoice. Ended by valid_to rather than deleted, for the same reason
-- transport_allocations are: the fee already raised has to stay explicable.
--
-- amount_paise is what is charged per instalment raised, the way a
-- fee_structure_items line is. A demand for the whole year multiplies it by
-- the instalments the structure has.
CREATE TABLE student_fee_components (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id)   ON DELETE CASCADE,
    student_id       uuid NOT NULL REFERENCES students(id)       ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    -- The head the invoice line is raised under. RESTRICT, as every other
    -- reference to a fee head is: a head with money charged under it is not
    -- deletable.
    fee_head_id      uuid NOT NULL REFERENCES fee_heads(id) ON DELETE RESTRICT,
    -- What kind of charge this is. 'transport' today; a hostel bed or a
    -- lab deposit would be the next ones, and they would be rows here rather
    -- than columns on the student.
    code             text NOT NULL,
    description      text NOT NULL,
    amount_paise     bigint NOT NULL,
    valid_from       date NOT NULL DEFAULT CURRENT_DATE,
    valid_to         date,
    source_kind      text,
    source_id        uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_fee_components_amount CHECK (amount_paise >= 0),
    CONSTRAINT student_fee_components_code   CHECK (code IN ('transport', 'hostel', 'other')),
    CONSTRAINT student_fee_components_window CHECK (valid_to IS NULL OR valid_to >= valid_from - 1)
);

-- One live charge of a kind per child. Moving stop ends the old row and
-- writes a new one; two live transport rows would bill the bus twice.
CREATE UNIQUE INDEX student_fee_components_one_live
    ON student_fee_components (student_id, code)
 WHERE valid_to IS NULL;

CREATE INDEX student_fee_components_student
    ON student_fee_components (institution_id, student_id, academic_year_id);

ALTER TABLE student_fee_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_components FORCE  ROW LEVEL SECURITY;
CREATE POLICY student_fee_components_tenant ON student_fee_components
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON student_fee_components TO app_user;

-- +goose Down

DROP TABLE IF EXISTS student_fee_components;
