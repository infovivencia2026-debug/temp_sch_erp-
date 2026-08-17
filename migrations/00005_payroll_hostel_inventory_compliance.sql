-- +goose Up
-- Tables the baseline never had: payroll, hostel, inventory, and the
-- statutory identifiers an Indian school is now required to hold.

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

-- ---------------------------------------------------------------- compliance
-- UDISE+ and APAAR are annual statutory returns, not optional metadata: the
-- school's own code, and one identifier per student that must reconcile with
-- the government register.
ALTER TABLE institutions
    ADD COLUMN IF NOT EXISTS udise_code        text,
    ADD COLUMN IF NOT EXISTS affiliation_board text,
    ADD COLUMN IF NOT EXISTS affiliation_no    text,
    ADD COLUMN IF NOT EXISTS affiliation_valid_to date;

ALTER TABLE students
    ADD COLUMN IF NOT EXISTS apaar_id           text,
    ADD COLUMN IF NOT EXISTS prior_udise_code   text,
    ADD COLUMN IF NOT EXISTS prior_school       text,
    ADD COLUMN IF NOT EXISTS prior_tc_no        text,
    -- Aadhaar itself is never stored; only the consent flag and last four,
    -- which the schema already carries as aadhaar_last4.
    ADD COLUMN IF NOT EXISTS aadhaar_consent    boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_rte             boolean NOT NULL DEFAULT false;

-- APAAR is one-per-student nationally; a duplicate inside a school is a data
-- error that would fail the UDISE+ return.
CREATE UNIQUE INDEX IF NOT EXISTS students_apaar_id
    ON students (institution_id, apaar_id) WHERE apaar_id IS NOT NULL;

-- ------------------------------------------------------------------- payroll
CREATE TABLE IF NOT EXISTS salary_components (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    code           text NOT NULL,
    name           text NOT NULL,
    kind           text NOT NULL,
    -- Order matters: HRA is a percentage of Basic, so Basic must compute first.
    sequence       integer NOT NULL DEFAULT 0,
    is_percent     boolean NOT NULL DEFAULT false,
    percent_of     text,
    is_statutory   boolean NOT NULL DEFAULT false,
    CONSTRAINT salary_components_kind_check
        CHECK (kind = ANY (ARRAY['earning','deduction','employer_contribution'])),
    UNIQUE (institution_id, code)
);

CREATE TABLE IF NOT EXISTS salary_structures (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    effective_from date NOT NULL,
    effective_to   date,
    ctc_paise      bigint NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT salary_structures_ctc_check CHECK (ctc_paise >= 0)
);

CREATE TABLE IF NOT EXISTS salary_structure_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    salary_structure_id uuid NOT NULL REFERENCES salary_structures(id) ON DELETE CASCADE,
    component_id        uuid NOT NULL REFERENCES salary_components(id) ON DELETE CASCADE,
    amount_paise        bigint NOT NULL DEFAULT 0,
    percent             numeric(5,2),
    CONSTRAINT salary_structure_items_amount_check CHECK (amount_paise >= 0)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    period_month   integer NOT NULL,
    period_year    integer NOT NULL,
    status         text NOT NULL DEFAULT 'draft',
    gross_paise    bigint NOT NULL DEFAULT 0,
    deduction_paise bigint NOT NULL DEFAULT 0,
    net_paise      bigint NOT NULL DEFAULT 0,
    employees      integer NOT NULL DEFAULT 0,
    run_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    locked_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payroll_runs_month_check CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT payroll_runs_status_check
        CHECK (status = ANY (ARRAY['draft','processed','locked','paid'])),
    -- One run per month. Re-running must amend, never duplicate salaries.
    UNIQUE (institution_id, period_year, period_month)
);

CREATE TABLE IF NOT EXISTS payslips (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    payroll_run_id  uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    paid_days       numeric(5,1) NOT NULL DEFAULT 0,
    lop_days        numeric(5,1) NOT NULL DEFAULT 0,
    gross_paise     bigint NOT NULL DEFAULT 0,
    deduction_paise bigint NOT NULL DEFAULT 0,
    net_paise       bigint NOT NULL DEFAULT 0,
    -- The computed breakup, frozen at run time. A payslip must keep showing the
    -- numbers it was issued with even after the salary structure changes.
    breakup         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (payroll_run_id, employee_id)
);

-- -------------------------------------------------------------------- hostel
CREATE TABLE IF NOT EXISTS hostel_blocks (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
    name           text NOT NULL,
    gender         text,
    warden_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT hostel_blocks_gender_check
        CHECK (gender IS NULL OR gender = ANY (ARRAY['male','female','mixed']))
);

CREATE TABLE IF NOT EXISTS hostel_rooms (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    block_id       uuid NOT NULL REFERENCES hostel_blocks(id) ON DELETE CASCADE,
    room_no        text NOT NULL,
    floor          integer NOT NULL DEFAULT 0,
    beds           integer NOT NULL DEFAULT 1,
    CONSTRAINT hostel_rooms_beds_check CHECK (beds > 0),
    UNIQUE (block_id, room_no)
);

CREATE TABLE IF NOT EXISTS hostel_allocations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    room_id        uuid NOT NULL REFERENCES hostel_rooms(id) ON DELETE CASCADE,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    bed_no         integer NOT NULL DEFAULT 1,
    allocated_on   date NOT NULL DEFAULT CURRENT_DATE,
    vacated_on     date
);

-- A bed holds one boarder at a time. Partial so a vacated bed frees up.
CREATE UNIQUE INDEX IF NOT EXISTS hostel_allocations_bed
    ON hostel_allocations (room_id, bed_no) WHERE vacated_on IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hostel_allocations_student
    ON hostel_allocations (student_id) WHERE vacated_on IS NULL;

-- ----------------------------------------------------------------- inventory
CREATE TABLE IF NOT EXISTS inventory_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE CASCADE,
    code           text NOT NULL,
    name           text NOT NULL,
    category       text,
    unit           text NOT NULL DEFAULT 'nos',
    reorder_level  integer NOT NULL DEFAULT 0,
    -- Denormalised running balance, maintained by the stock trigger below so a
    -- stock list does not have to sum every movement ever recorded.
    on_hand        integer NOT NULL DEFAULT 0,
    UNIQUE (institution_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    item_id        uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    kind           text NOT NULL,
    quantity       integer NOT NULL,
    unit_cost_paise bigint,
    reference      text,
    issued_to      uuid REFERENCES employees(id) ON DELETE SET NULL,
    moved_on       date NOT NULL DEFAULT CURRENT_DATE,
    remarks        text,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inventory_movements_kind_check
        CHECK (kind = ANY (ARRAY['receipt','issue','adjustment','return'])),
    CONSTRAINT inventory_movements_quantity_check CHECK (quantity <> 0)
);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION sync_inventory_on_hand() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target uuid := COALESCE(NEW.item_id, OLD.item_id);
BEGIN
    UPDATE inventory_items i
       SET on_hand = COALESCE((
           SELECT sum(CASE WHEN m.kind IN ('receipt','return') THEN m.quantity
                           WHEN m.kind = 'issue'               THEN -m.quantity
                           ELSE m.quantity END)
             FROM inventory_movements m WHERE m.item_id = target), 0)
     WHERE i.id = target;
    RETURN NULL;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS inventory_movements_sync ON inventory_movements;
CREATE TRIGGER inventory_movements_sync
    AFTER INSERT OR UPDATE OR DELETE ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION sync_inventory_on_hand();

-- ------------------------------------------------------------------ tenancy
-- Every new table needs the same tenant policy as the rest of the schema.
-- Forgetting one is how a tenant boundary quietly develops a hole.
-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'salary_components','salary_structures','salary_structure_items',
        'payroll_runs','payslips','hostel_blocks','hostel_rooms',
        'hostel_allocations','inventory_items','inventory_movements',
        'fee_fine_rules'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (app_is_platform_admin() '
            'OR institution_id = app_current_institution()) WITH CHECK '
            '(app_is_platform_admin() OR institution_id = app_current_institution())', t);
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS inventory_movements_sync ON inventory_movements;
DROP FUNCTION IF EXISTS sync_inventory_on_hand();
DROP TABLE IF EXISTS inventory_movements, inventory_items,
                     hostel_allocations, hostel_rooms, hostel_blocks,
                     payslips, payroll_runs, salary_structure_items,
                     salary_structures, salary_components;
ALTER TABLE students DROP COLUMN IF EXISTS apaar_id, DROP COLUMN IF EXISTS prior_udise_code,
    DROP COLUMN IF EXISTS prior_school, DROP COLUMN IF EXISTS prior_tc_no,
    DROP COLUMN IF EXISTS aadhaar_consent, DROP COLUMN IF EXISTS is_rte;
ALTER TABLE institutions DROP COLUMN IF EXISTS udise_code,
    DROP COLUMN IF EXISTS affiliation_board, DROP COLUMN IF EXISTS affiliation_no,
    DROP COLUMN IF EXISTS affiliation_valid_to;
