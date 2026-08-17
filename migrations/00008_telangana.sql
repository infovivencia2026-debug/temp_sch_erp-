-- +goose Up
-- Telangana localisation.
--
-- A school in Telangana reports to two separate systems, not one: UDISE+
-- nationally and Child Info (childinfo.telangana.gov.in) at state level, each
-- with its own identifiers. It also follows a June-April academic year, teaches
-- in Telugu, English or Urdu, and — if it is on the state board — assesses
-- through CCE rather than a single term exam.
--
-- Caste and social category are deliberately not modelled here.

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

-- ------------------------------------------------------------- institution
ALTER TABLE institutions
    ADD COLUMN IF NOT EXISTS state            text,
    ADD COLUMN IF NOT EXISTS district         text,
    -- Mandal is the administrative tier between district and village in
    -- Telangana and Andhra Pradesh; every state return is filed against it.
    ADD COLUMN IF NOT EXISTS mandal           text,
    ADD COLUMN IF NOT EXISTS village_or_ward  text,
    ADD COLUMN IF NOT EXISTS school_category  text,
    ADD COLUMN IF NOT EXISTS management_type  text,
    ADD COLUMN IF NOT EXISTS child_info_code  text,
    ADD COLUMN IF NOT EXISTS mid_day_meal     boolean NOT NULL DEFAULT false;

ALTER TABLE institutions
    ADD CONSTRAINT institutions_management_type_check CHECK (
        management_type IS NULL OR management_type = ANY (ARRAY[
            'government','aided','private_unaided','model_school',
            'gurukul','kgbv','central'])),
    ADD CONSTRAINT institutions_school_category_check CHECK (
        school_category IS NULL OR school_category = ANY (ARRAY[
            'primary','upper_primary','high_school','higher_secondary','composite']));

-- ---------------------------------------------------------------- students
ALTER TABLE students
    -- Child Info is the Telangana state student register, distinct from UDISE+
    -- and from APAAR. A school reconciles all three.
    ADD COLUMN IF NOT EXISTS child_info_id    text,
    ADD COLUMN IF NOT EXISTS medium           text,
    ADD COLUMN IF NOT EXISTS second_language  text,
    ADD COLUMN IF NOT EXISTS third_language   text,
    ADD COLUMN IF NOT EXISTS is_cwsn          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS cwsn_type        text,
    ADD COLUMN IF NOT EXISTS bank_account     text,
    ADD COLUMN IF NOT EXISTS bank_ifsc        text;

ALTER TABLE students
    ADD CONSTRAINT students_medium_check CHECK (
        medium IS NULL OR medium = ANY (ARRAY['telugu','english','urdu','hindi','other']));

CREATE UNIQUE INDEX IF NOT EXISTS students_child_info_id
    ON students (institution_id, child_info_id) WHERE child_info_id IS NOT NULL;

-- ------------------------------------------------------------ academic year
-- The Telangana school year runs June to April, while the financial year runs
-- April to March. Fee receipts are numbered on the financial year and academic
-- records on the school year, so the two are tracked separately rather than
-- assumed to be the same thing.
ALTER TABLE academic_years
    ADD COLUMN IF NOT EXISTS board          text,
    ADD COLUMN IF NOT EXISTS working_days   integer;

-- -------------------------------------------------------------- assessment
-- Telangana SSC assesses through CCE: four Formative Assessments of 20 marks
-- and Summative Assessments of 80, combined per subject. Modelling this as a
-- component of the exam rather than a separate exam is what lets a report card
-- show "FA1 18/20, SA1 63/80" the way a TS report card actually does.
ALTER TABLE exams
    ADD COLUMN IF NOT EXISTS assessment_type text,
    ADD COLUMN IF NOT EXISTS cce_component   text,
    ADD COLUMN IF NOT EXISTS board           text;

ALTER TABLE exams
    ADD CONSTRAINT exams_cce_component_check CHECK (
        cce_component IS NULL OR cce_component = ANY (ARRAY[
            'FA1','FA2','FA3','FA4','SA1','SA2','SA3']));

-- -------------------------------------------------------- board registration
-- SSC (Class 10) and Intermediate (11-12) candidates are registered with the
-- board months before the exam, and the nominal roll is what the hall ticket
-- is issued against.
CREATE TABLE IF NOT EXISTS board_registrations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    board            text NOT NULL,
    exam_name        text NOT NULL,
    registration_no  text,
    hall_ticket_no   text,
    medium           text,
    subjects         jsonb NOT NULL DEFAULT '[]'::jsonb,
    fee_paid_paise   bigint NOT NULL DEFAULT 0,
    status           text NOT NULL DEFAULT 'draft',
    submitted_on     date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT board_registrations_status_check CHECK (
        status = ANY (ARRAY['draft','submitted','accepted','hall_ticket_issued','rejected'])),
    UNIQUE (institution_id, student_id, academic_year_id, exam_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS board_registrations_hall_ticket
    ON board_registrations (institution_id, hall_ticket_no)
    WHERE hall_ticket_no IS NOT NULL;

-- ------------------------------------------------------------ mid-day meal
-- Government and aided schools report a daily cooked-meal headcount; the
-- entitlement and the rice quota are settled against it.
CREATE TABLE IF NOT EXISTS mdm_registers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE CASCADE,
    on_date        date NOT NULL,
    enrolled       integer NOT NULL DEFAULT 0,
    present        integer NOT NULL DEFAULT 0,
    meals_served   integer NOT NULL DEFAULT 0,
    rice_kg        numeric(8,2),
    cost_paise     bigint NOT NULL DEFAULT 0,
    menu           text,
    recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mdm_registers_counts_check
        CHECK (present >= 0 AND meals_served >= 0 AND enrolled >= 0),
    UNIQUE (institution_id, campus_id, on_date)
);

-- --------------------------------------------------------------- tenancy
-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['board_registrations','mdm_registers'] LOOP
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
DROP TABLE IF EXISTS mdm_registers, board_registrations;
ALTER TABLE exams DROP COLUMN IF EXISTS assessment_type,
    DROP COLUMN IF EXISTS cce_component, DROP COLUMN IF EXISTS board;
ALTER TABLE academic_years DROP COLUMN IF EXISTS board, DROP COLUMN IF EXISTS working_days;
ALTER TABLE students DROP COLUMN IF EXISTS child_info_id, DROP COLUMN IF EXISTS medium,
    DROP COLUMN IF EXISTS second_language, DROP COLUMN IF EXISTS third_language,
    DROP COLUMN IF EXISTS is_cwsn, DROP COLUMN IF EXISTS cwsn_type,
    DROP COLUMN IF EXISTS bank_account, DROP COLUMN IF EXISTS bank_ifsc;
ALTER TABLE institutions DROP COLUMN IF EXISTS state, DROP COLUMN IF EXISTS district,
    DROP COLUMN IF EXISTS mandal, DROP COLUMN IF EXISTS village_or_ward,
    DROP COLUMN IF EXISTS school_category, DROP COLUMN IF EXISTS management_type,
    DROP COLUMN IF EXISTS child_info_code, DROP COLUMN IF EXISTS mid_day_meal;
