-- +goose Up
-- Statutory payroll: what the government takes, and what the school owes.
--
-- The product could compute a payslip from a salary structure. Everything a
-- payroll clerk does around that — the PF and ESI returns, professional tax,
-- the investment declarations that decide TDS, staff advances, the gratuity a
-- school is silently accruing, and the bank file that actually moves the money
-- — had nowhere to live.
--
-- Every rate here is configurable rather than compiled in. The EPF ceiling has
-- moved twice in living memory and ESI's threshold three times; a rate in Go
-- is a rate that needs a deploy on the day the gazette changes.

/* One row per school. Deliberately columns rather than a settings blob:
   these are numbers an auditor reads and a clerk edits, and a jsonb field
   nobody can constrain is where wrong rates hide. */
CREATE TABLE payroll_settings (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- Employees' Provident Fund. 12% each side is statutory; the ceiling is
    -- the wage above which contribution is optional, not the wage above which
    -- it stops, which is why it is stored rather than assumed.
    pf_enabled          boolean NOT NULL DEFAULT true,
    pf_employee_percent numeric(5,2) NOT NULL DEFAULT 12.00,
    pf_employer_percent numeric(5,2) NOT NULL DEFAULT 12.00,
    pf_wage_ceiling_paise bigint NOT NULL DEFAULT 1500000,
    -- Of the employer's 12%, this much goes to the pension scheme and the
    -- remainder to PF proper. The split is what an ECR file must show.
    eps_percent         numeric(5,2) NOT NULL DEFAULT 8.33,
    pf_admin_percent    numeric(5,2) NOT NULL DEFAULT 0.50,
    pf_establishment_code text,

    -- Employees' State Insurance. Applies only below the wage threshold, and
    -- for a whole contribution period once it starts — a mid-period raise does
    -- not end coverage, which is the rule schools most often get wrong.
    esi_enabled         boolean NOT NULL DEFAULT true,
    esi_employee_percent numeric(5,2) NOT NULL DEFAULT 0.75,
    esi_employer_percent numeric(5,2) NOT NULL DEFAULT 3.25,
    esi_wage_threshold_paise bigint NOT NULL DEFAULT 2100000,
    esi_code            text,

    -- Professional tax is a state subject; the slabs live in their own table.
    pt_state            text NOT NULL DEFAULT 'Telangana',
    pt_enabled          boolean NOT NULL DEFAULT true,

    -- What a proxy period and an hour of overtime are worth. Both are school
    -- policy rather than law, which is exactly why they belong in settings and
    -- not in a formula.
    substitution_rate_paise bigint NOT NULL DEFAULT 20000,
    overtime_hourly_paise   bigint NOT NULL DEFAULT 15000,
    overtime_holiday_multiplier numeric(4,2) NOT NULL DEFAULT 2.00,

    -- Gratuity: 15 days' wages for every completed year, on a 26-day month,
    -- payable after five years. The divisor and numerator are stored because
    -- schools with a six-day week and schools with five compute them
    -- differently and both are defensible.
    gratuity_days       integer NOT NULL DEFAULT 15,
    gratuity_month_days integer NOT NULL DEFAULT 26,
    gratuity_min_years  integer NOT NULL DEFAULT 5,
    gratuity_cap_paise  bigint  NOT NULL DEFAULT 2000000000,

    bank_name           text,
    bank_account        text,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payroll_settings_percentages CHECK (
        pf_employee_percent BETWEEN 0 AND 100 AND
        pf_employer_percent BETWEEN 0 AND 100 AND
        eps_percent BETWEEN 0 AND pf_employer_percent AND
        esi_employee_percent BETWEEN 0 AND 100 AND
        esi_employer_percent BETWEEN 0 AND 100)
);

/* Professional tax slabs, per state.

   Stored as half-open ranges with a null upper bound for the top slab, so a
   gap or an overlap is visible rather than implied. Telangana's are seeded
   below; a school in another state edits them rather than waiting for us. */
CREATE TABLE pt_slabs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    state           text NOT NULL,
    from_paise      bigint NOT NULL,
    to_paise        bigint,
    monthly_paise   bigint NOT NULL,
    -- Several states charge a different amount in one month of the year to
    -- reach an annual cap. A column beats a special case in code.
    february_paise  bigint,
    CONSTRAINT pt_slabs_range CHECK (to_paise IS NULL OR to_paise > from_paise)
);

CREATE INDEX pt_slabs_lookup ON pt_slabs (institution_id, state, from_paise);

/* What an employee says they will invest, and what the office believed.

   declared and verified are separate amounts on purpose. A declaration in
   April is a promise; the proof arrives in January; TDS through the year is
   computed on the promise and corrected on the proof, and a single column
   would lose the difference that Form 12BB exists to record. */
CREATE TABLE investment_declarations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- The Indian financial year the declaration is for, as its starting year:
    -- 2026 means April 2026 to March 2027.
    fy_start_year   integer NOT NULL,
    section         text NOT NULL,
    particulars     text NOT NULL,
    declared_paise  bigint NOT NULL DEFAULT 0,
    verified_paise  bigint,
    proof_file_id   uuid REFERENCES files(id) ON DELETE SET NULL,
    status          text NOT NULL DEFAULT 'declared',
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT investment_declarations_status
        CHECK (status IN ('declared','proof_submitted','verified','rejected')),
    CONSTRAINT investment_declarations_verified_has_amount
        CHECK (status <> 'verified' OR verified_paise IS NOT NULL),
    CONSTRAINT investment_declarations_rejected_has_reason
        CHECK (status <> 'rejected' OR nullif(btrim(remarks), '') IS NOT NULL)
);

CREATE INDEX investment_declarations_employee
    ON investment_declarations (employee_id, fy_start_year);

/* A salary advance or loan.

   The outstanding balance is derived from the instalments actually deducted
   rather than stored, because a stored balance and a payslip history that
   disagree is the kind of argument that ends in a labour court. */
CREATE TABLE staff_loans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind            text NOT NULL DEFAULT 'advance',
    principal_paise bigint NOT NULL,
    instalment_paise bigint NOT NULL,
    -- The month deductions begin, as year and month rather than a date: payroll
    -- runs on periods, and a date invites a question about which day.
    start_year      integer NOT NULL,
    start_month     integer NOT NULL,
    reason          text,
    status          text NOT NULL DEFAULT 'active',
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    closed_on       date,
    CONSTRAINT staff_loans_kind CHECK (kind IN ('advance','loan','pf_loan','festival')),
    CONSTRAINT staff_loans_status CHECK (status IN ('active','closed','cancelled')),
    CONSTRAINT staff_loans_amounts
        CHECK (principal_paise > 0 AND instalment_paise > 0
               AND instalment_paise <= principal_paise),
    CONSTRAINT staff_loans_month CHECK (start_month BETWEEN 1 AND 12)
);

-- One instalment actually taken, tied to the run that took it. This is what
-- makes the outstanding balance derivable and the payslip explicable.
CREATE TABLE loan_deductions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    loan_id         uuid NOT NULL REFERENCES staff_loans(id) ON DELETE CASCADE,
    payroll_run_id  uuid REFERENCES payroll_runs(id) ON DELETE SET NULL,
    period_year     integer NOT NULL,
    period_month    integer NOT NULL,
    amount_paise    bigint NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- A loan cannot be deducted twice in one month.
CREATE UNIQUE INDEX loan_deductions_one_per_period
    ON loan_deductions (loan_id, period_year, period_month);

/* Outsourced staff: security guards, cleaners, gardeners.

   Not employees — they are the contractor's people, and putting them in the
   employees table would inflate every headcount the school reports. What the
   school verifies is a bill: how many bodies the contractor claims against how
   many the gate actually saw. */
CREATE TABLE contractor_bills (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vendor          text NOT NULL,
    service         text NOT NULL DEFAULT 'security',
    period_year     integer NOT NULL,
    period_month    integer NOT NULL,
    invoice_no      text,
    -- Person-days claimed against person-days verified. Two numbers because
    -- the gap between them is the entire reason this table exists.
    claimed_days    integer NOT NULL,
    verified_days   integer,
    rate_paise      bigint NOT NULL,
    claimed_paise   bigint NOT NULL,
    approved_paise  bigint,
    status          text NOT NULL DEFAULT 'received',
    remarks         text,
    verified_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contractor_bills_status
        CHECK (status IN ('received','verified','disputed','paid')),
    CONSTRAINT contractor_bills_verified_has_days
        CHECK (status = 'received' OR verified_days IS NOT NULL),
    -- Short-paying a contractor without saying why is how a school ends up in
    -- a dispute it cannot explain.
    CONSTRAINT contractor_bills_shortfall_explained
        CHECK (approved_paise IS NULL OR approved_paise >= claimed_paise
               OR nullif(btrim(remarks), '') IS NOT NULL),
    CONSTRAINT contractor_bills_month CHECK (period_month BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX contractor_bills_one_per_vendor_period
    ON contractor_bills (institution_id, vendor, service, period_year, period_month);

ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE pt_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pt_slabs FORCE ROW LEVEL SECURITY;
ALTER TABLE investment_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE investment_declarations FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_loans FORCE ROW LEVEL SECURITY;
ALTER TABLE loan_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_deductions FORCE ROW LEVEL SECURITY;
ALTER TABLE contractor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractor_bills FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_settings_tenant ON payroll_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY pt_slabs_tenant ON pt_slabs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY investment_declarations_tenant ON investment_declarations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_loans_tenant ON staff_loans
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY loan_deductions_tenant ON loan_deductions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY contractor_bills_tenant ON contractor_bills
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose StatementBegin
-- Give every existing school the statutory defaults and Telangana's PT slabs,
-- so payroll works on the day this ships rather than after a setup screen.
DO $$
DECLARE inst uuid;
BEGIN
    -- institutions is itself under FORCE row-level security, so without this
    -- the loop below sees no rows and seeds nothing at all — silently, because
    -- iterating an empty result is not an error.
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        INSERT INTO payroll_settings (institution_id) VALUES (inst)
        ON CONFLICT DO NOTHING;
        INSERT INTO pt_slabs (institution_id, state, from_paise, to_paise, monthly_paise)
        VALUES (inst, 'Telangana', 0, 1500000, 0),
               (inst, 'Telangana', 1500000, 2000000, 15000),
               (inst, 'Telangana', 2000000, NULL, 20000)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS contractor_bills;
DROP TABLE IF EXISTS loan_deductions;
DROP TABLE IF EXISTS staff_loans;
DROP TABLE IF EXISTS investment_declarations;
DROP TABLE IF EXISTS pt_slabs;
DROP TABLE IF EXISTS payroll_settings;
