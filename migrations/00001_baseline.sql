-- +goose Up
-- Baseline schema, recovered from production at erp.187-127-178-100.sslip.io
-- (pg_dump -s, 2026-08-16).
--
-- Upstream had 16 incremental migrations, but those files were never committed
-- and do not exist on the server, so this collapses their end state into one
-- baseline: 85 tables, 124 indexes, 82 RLS policies, 5 functions.
--
-- Role grants are deliberately absent: pg_dump names the roles of the database
-- it came from (erp_owner / app_user), and each deployment namespaces its own
-- (<service>_owner / <service>_app). scripts/deploy.sh grants the app role what
-- it needs, including default privileges for future tables.
--
-- Cleaning is dollar-quote aware. An earlier pass filtered every line starting
-- with "SET " to drop pg_dump's session preamble, which also deleted
-- "SET allocated_paise = COALESCE(" from inside sync_payment_allocated and
-- produced a function that parsed at CREATE time (bodies are unchecked below)
-- and then failed at runtime on the first payment allocation.

-- pg_dump emits functions ahead of the tables they reference, and
-- sync_invoice_paid declares `inv invoices%ROWTYPE`. plpgsql resolves that at
-- CREATE time unless body checking is off.
SET check_function_bodies = false;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';

-- +goose StatementBegin
CREATE FUNCTION public.app_current_institution() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    SELECT NULLIF(current_setting('app.institution_id', true), '')::uuid;
$$;
-- +goose StatementEnd



-- +goose StatementBegin
CREATE FUNCTION public.app_is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(NULLIF(current_setting('app.is_platform_admin', true), ''), 'off') = 'on';
$$;
-- +goose StatementEnd



-- +goose StatementBegin
CREATE FUNCTION public.sync_invoice_paid() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
    total  bigint;
    inv    invoices%ROWTYPE;
BEGIN
    SELECT COALESCE(sum(amount_paise), 0) INTO total
      FROM payment_allocations WHERE invoice_id = target;

    UPDATE invoices SET paid_paise = total WHERE id = target;
    SELECT * INTO inv FROM invoices WHERE id = target;

    UPDATE invoices SET status = CASE
        WHEN inv.status = 'cancelled' THEN 'cancelled'
        WHEN total >= inv.net_paise AND inv.net_paise > 0 THEN 'paid'
        WHEN total > 0 THEN 'partial'
        WHEN inv.due_on IS NOT NULL AND inv.due_on < CURRENT_DATE THEN 'overdue'
        ELSE 'unpaid'
    END
    WHERE id = target;

    RETURN NULL;
END $$;
-- +goose StatementEnd



-- +goose StatementBegin
CREATE FUNCTION public.sync_payment_allocated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target uuid := COALESCE(NEW.payment_id, OLD.payment_id);
BEGIN
    UPDATE payments p
       SET allocated_paise = COALESCE(
           (SELECT sum(amount_paise) FROM payment_allocations WHERE payment_id = target), 0)
     WHERE p.id = target;
    RETURN NULL;
END $$;
-- +goose StatementEnd



-- +goose StatementBegin
CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;
-- +goose StatementEnd



CREATE TABLE public.academic_years (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    name text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT academic_years_check CHECK ((ends_on > starts_on))
);

ALTER TABLE ONLY public.academic_years FORCE ROW LEVEL SECURITY;


CREATE TABLE public.admission_assessments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    application_id uuid NOT NULL,
    kind text NOT NULL,
    scheduled_at timestamp with time zone,
    venue text,
    conducted_by uuid,
    score numeric(6,2),
    max_score numeric(6,2),
    outcome text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_assessments_kind_check CHECK ((kind = ANY (ARRAY['entrance_test'::text, 'interview'::text]))),
    CONSTRAINT admission_assessments_outcome_check CHECK ((outcome = ANY (ARRAY['pass'::text, 'fail'::text, 'pending'::text, 'absent'::text])))
);

ALTER TABLE ONLY public.admission_assessments FORCE ROW LEVEL SECURITY;


CREATE TABLE public.admission_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    name text NOT NULL,
    opens_on date,
    closes_on date,
    is_open boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.admission_sessions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.announcement_acks (
    announcement_id uuid NOT NULL,
    user_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    acked_at timestamp with time zone DEFAULT now() NOT NULL,
    response text
);

ALTER TABLE ONLY public.announcement_acks FORCE ROW LEVEL SECURITY;


CREATE TABLE public.announcement_sections (
    announcement_id uuid NOT NULL,
    section_id uuid NOT NULL,
    institution_id uuid NOT NULL
);

ALTER TABLE ONLY public.announcement_sections FORCE ROW LEVEL SECURITY;


CREATE TABLE public.announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    title text NOT NULL,
    body text NOT NULL,
    kind text DEFAULT 'announcement'::text NOT NULL,
    audience_role text DEFAULT 'all'::text NOT NULL,
    attachment_file_id uuid,
    requires_ack boolean DEFAULT false NOT NULL,
    publish_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcements_audience_role_check CHECK ((audience_role = ANY (ARRAY['all'::text, 'students'::text, 'parents'::text, 'staff'::text, 'faculty'::text]))),
    CONSTRAINT announcements_kind_check CHECK ((kind = ANY (ARRAY['announcement'::text, 'circular'::text, 'notice'::text, 'emergency'::text])))
);

ALTER TABLE ONLY public.announcements FORCE ROW LEVEL SECURITY;


CREATE TABLE public.application_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    application_id uuid NOT NULL,
    file_id uuid,
    doc_type text NOT NULL,
    is_required boolean DEFAULT true NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.application_documents FORCE ROW LEVEL SECURITY;


CREATE TABLE public.applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    admission_session_id uuid,
    enquiry_id uuid,
    application_no text NOT NULL,
    first_name text NOT NULL,
    middle_name text,
    last_name text,
    date_of_birth date,
    gender text,
    category text,
    class_sought uuid NOT NULL,
    parent_name text NOT NULL,
    parent_phone text NOT NULL,
    parent_email public.citext,
    address text,
    previous_school text,
    is_rte boolean DEFAULT false NOT NULL,
    rte_status text,
    status text DEFAULT 'draft'::text NOT NULL,
    student_id uuid,
    decided_by uuid,
    decided_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT applications_category_check CHECK ((category = ANY (ARRAY['general'::text, 'obc'::text, 'sc'::text, 'st'::text, 'ews'::text, 'other'::text]))),
    CONSTRAINT applications_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text]))),
    CONSTRAINT applications_rte_status_check CHECK ((rte_status = ANY (ARRAY['applied'::text, 'eligible'::text, 'selected'::text, 'rejected'::text]))),
    CONSTRAINT applications_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'under_review'::text, 'documents_pending'::text, 'test_scheduled'::text, 'interviewed'::text, 'offered'::text, 'accepted'::text, 'rejected'::text, 'withdrawn'::text, 'waitlisted'::text])))
);

ALTER TABLE ONLY public.applications FORCE ROW LEVEL SECURITY;


CREATE TABLE public.attendance_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    attendance_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    from_status text NOT NULL,
    to_status text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attendance_corrections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.attendance_corrections FORCE ROW LEVEL SECURITY;


CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    institution_id uuid,
    campus_id uuid,
    actor_user_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    before jsonb,
    after jsonb,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;


CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;

CREATE TABLE public.campuses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    address_line1 text,
    address_line2 text,
    city text,
    state text,
    pincode text,
    phone text,
    email public.citext,
    academic_model text DEFAULT 'k12'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campuses_academic_model_check CHECK ((academic_model = ANY (ARRAY['k12'::text, 'higher_ed'::text]))),
    CONSTRAINT campuses_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.campuses FORCE ROW LEVEL SECURITY;


CREATE TABLE public.certificate_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    template_html text,
    requires_approval boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.certificate_types FORCE ROW LEVEL SECURITY;


CREATE TABLE public.class_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    class_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    is_elective boolean DEFAULT false NOT NULL,
    max_marks integer DEFAULT 100 NOT NULL
);

ALTER TABLE ONLY public.class_subjects FORCE ROW LEVEL SECURITY;


CREATE TABLE public.classes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    name text NOT NULL,
    level integer NOT NULL,
    stream text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.classes FORCE ROW LEVEL SECURITY;


CREATE TABLE public.departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    name text NOT NULL,
    head_user_id uuid
);

ALTER TABLE ONLY public.departments FORCE ROW LEVEL SECURITY;


CREATE TABLE public.designations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    name text NOT NULL,
    category text,
    CONSTRAINT designations_category_check CHECK ((category = ANY (ARRAY['teaching'::text, 'non_teaching'::text, 'support'::text, 'management'::text])))
);

ALTER TABLE ONLY public.designations FORCE ROW LEVEL SECURITY;


CREATE TABLE public.discipline_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    occurred_on date DEFAULT CURRENT_DATE NOT NULL,
    category text NOT NULL,
    is_positive boolean DEFAULT false NOT NULL,
    description text NOT NULL,
    action_taken text,
    visible_to_student boolean DEFAULT true NOT NULL,
    parent_notified boolean DEFAULT false NOT NULL,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.discipline_records FORCE ROW LEVEL SECURITY;


CREATE TABLE public.employee_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    file_id uuid NOT NULL,
    doc_type text NOT NULL,
    expires_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.employee_documents FORCE ROW LEVEL SECURITY;


CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    user_id uuid,
    employee_code text NOT NULL,
    first_name text NOT NULL,
    last_name text,
    date_of_birth date,
    gender text,
    phone text,
    email public.citext,
    photo_file_id uuid,
    department_id uuid,
    designation_id uuid,
    employment_type text,
    joined_on date DEFAULT CURRENT_DATE NOT NULL,
    confirmed_on date,
    relieved_on date,
    status text DEFAULT 'active'::text NOT NULL,
    qualification text,
    experience_years numeric(4,1),
    pan text,
    aadhaar_last4 text,
    uan text,
    esi_number text,
    bank_account text,
    bank_ifsc text,
    address text,
    emergency_contact_name text,
    emergency_contact_phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employees_aadhaar_last4_check CHECK ((aadhaar_last4 ~ '^[0-9]{4}$'::text)),
    CONSTRAINT employees_employment_type_check CHECK ((employment_type = ANY (ARRAY['permanent'::text, 'contract'::text, 'probation'::text, 'part_time'::text, 'visiting'::text]))),
    CONSTRAINT employees_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text]))),
    CONSTRAINT employees_status_check CHECK ((status = ANY (ARRAY['active'::text, 'on_leave'::text, 'suspended'::text, 'resigned'::text, 'terminated'::text, 'retired'::text])))
);

ALTER TABLE ONLY public.employees FORCE ROW LEVEL SECURITY;


CREATE TABLE public.enquiries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    student_name text NOT NULL,
    parent_name text,
    phone text NOT NULL,
    email public.citext,
    class_sought uuid,
    source text DEFAULT 'walk_in'::text NOT NULL,
    campaign text,
    status text DEFAULT 'new'::text NOT NULL,
    assigned_to uuid,
    next_follow_up date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enquiries_source_check CHECK ((source = ANY (ARRAY['walk_in'::text, 'phone'::text, 'website'::text, 'referral'::text, 'campaign'::text, 'other'::text]))),
    CONSTRAINT enquiries_status_check CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'visit_scheduled'::text, 'applied'::text, 'lost'::text])))
);

ALTER TABLE ONLY public.enquiries FORCE ROW LEVEL SECURITY;


CREATE TABLE public.enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    class_id uuid NOT NULL,
    section_id uuid NOT NULL,
    roll_no integer,
    enrolled_on date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    promoted_from_id uuid,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enrollments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'promoted'::text, 'detained'::text, 'transferred'::text, 'withdrawn'::text, 'completed'::text])))
);

ALTER TABLE ONLY public.enrollments FORCE ROW LEVEL SECURITY;


CREATE TABLE public.exam_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    class_subject_id uuid NOT NULL,
    exam_date date,
    starts_at time without time zone,
    duration_minutes integer,
    max_marks numeric(6,2) DEFAULT 100 NOT NULL,
    pass_marks numeric(6,2) DEFAULT 33 NOT NULL
);

ALTER TABLE ONLY public.exam_subjects FORCE ROW LEVEL SECURITY;


CREATE TABLE public.exams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    term_id uuid,
    name text NOT NULL,
    kind text DEFAULT 'term'::text NOT NULL,
    weightage numeric(5,2) DEFAULT 100 NOT NULL,
    starts_on date,
    ends_on date,
    grading_scale_id uuid,
    is_published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exams_kind_check CHECK ((kind = ANY (ARRAY['unit_test'::text, 'periodic'::text, 'term'::text, 'practical'::text, 'internal'::text, 'formative'::text, 'summative'::text, 'board'::text])))
);

ALTER TABLE ONLY public.exams FORCE ROW LEVEL SECURITY;


CREATE TABLE public.fee_concessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    fee_head_id uuid,
    kind text NOT NULL,
    percent numeric(5,2),
    amount_paise bigint,
    reason text,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fee_concessions_amount_paise_check CHECK (((amount_paise IS NULL) OR (amount_paise >= 0))),
    CONSTRAINT fee_concessions_check CHECK (((percent IS NOT NULL) OR (amount_paise IS NOT NULL))),
    CONSTRAINT fee_concessions_kind_check CHECK ((kind = ANY (ARRAY['scholarship'::text, 'sibling'::text, 'staff_ward'::text, 'rte'::text, 'merit'::text, 'other'::text]))),
    CONSTRAINT fee_concessions_percent_check CHECK (((percent IS NULL) OR ((percent >= (0)::numeric) AND (percent <= (100)::numeric))))
);

ALTER TABLE ONLY public.fee_concessions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.fee_heads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    name text NOT NULL,
    code text NOT NULL,
    is_refundable boolean DEFAULT false NOT NULL,
    is_recurring boolean DEFAULT true NOT NULL,
    ledger_account text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.fee_heads FORCE ROW LEVEL SECURITY;


CREATE TABLE public.fee_structure_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    fee_structure_id uuid NOT NULL,
    fee_head_id uuid NOT NULL,
    instalment_no integer DEFAULT 1 NOT NULL,
    amount_paise bigint NOT NULL,
    due_on date,
    CONSTRAINT fee_structure_items_amount_paise_check CHECK ((amount_paise >= 0))
);

ALTER TABLE ONLY public.fee_structure_items FORCE ROW LEVEL SECURITY;


CREATE TABLE public.fee_structures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    class_id uuid,
    name text NOT NULL,
    applies_to text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fee_structures_applies_to_check CHECK ((applies_to = ANY (ARRAY['all'::text, 'rte'::text, 'hosteller'::text, 'day_scholar'::text, 'transport'::text])))
);

ALTER TABLE ONLY public.fee_structures FORCE ROW LEVEL SECURITY;


CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    object_key text NOT NULL,
    original_name text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 bytea,
    owner_type text,
    owner_id uuid,
    purpose text NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.files FORCE ROW LEVEL SECURITY;





CREATE TABLE public.grade_bands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    grading_scale_id uuid NOT NULL,
    grade text NOT NULL,
    min_percent numeric(5,2) NOT NULL,
    max_percent numeric(5,2) NOT NULL,
    grade_point numeric(4,2),
    description text,
    CONSTRAINT grade_bands_check CHECK ((max_percent >= min_percent))
);

ALTER TABLE ONLY public.grade_bands FORCE ROW LEVEL SECURITY;


CREATE TABLE public.grading_scales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.grading_scales FORCE ROW LEVEL SECURITY;


CREATE TABLE public.guardians (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    full_name text NOT NULL,
    relation text NOT NULL,
    phone text,
    email public.citext,
    occupation text,
    annual_income bigint,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guardians_relation_check CHECK ((relation = ANY (ARRAY['father'::text, 'mother'::text, 'guardian'::text, 'other'::text])))
);

ALTER TABLE ONLY public.guardians FORCE ROW LEVEL SECURITY;


CREATE TABLE public.holidays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    academic_year_id uuid,
    name text NOT NULL,
    on_date date NOT NULL,
    to_date date,
    kind text DEFAULT 'holiday'::text NOT NULL,
    applies_to text DEFAULT 'all'::text NOT NULL,
    description text,
    CONSTRAINT holidays_applies_to_check CHECK ((applies_to = ANY (ARRAY['all'::text, 'students'::text, 'staff'::text]))),
    CONSTRAINT holidays_kind_check CHECK ((kind = ANY (ARRAY['holiday'::text, 'vacation'::text, 'exam'::text, 'event'::text, 'ptm'::text, 'working_day'::text])))
);

ALTER TABLE ONLY public.holidays FORCE ROW LEVEL SECURITY;


CREATE TABLE public.homework (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    section_id uuid NOT NULL,
    class_subject_id uuid,
    kind text DEFAULT 'homework'::text NOT NULL,
    title text NOT NULL,
    instructions text,
    assigned_on date DEFAULT CURRENT_DATE NOT NULL,
    due_on date,
    max_marks numeric(6,2),
    is_published boolean DEFAULT true NOT NULL,
    allow_submission boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT homework_kind_check CHECK ((kind = ANY (ARRAY['homework'::text, 'classwork'::text, 'assignment'::text, 'project'::text])))
);

ALTER TABLE ONLY public.homework FORCE ROW LEVEL SECURITY;


CREATE TABLE public.homework_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    homework_id uuid NOT NULL,
    file_id uuid NOT NULL
);

ALTER TABLE ONLY public.homework_attachments FORCE ROW LEVEL SECURITY;


CREATE TABLE public.homework_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    homework_id uuid NOT NULL,
    student_id uuid NOT NULL,
    submitted_at timestamp with time zone,
    text_answer text,
    file_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    marks numeric(6,2),
    feedback text,
    graded_by uuid,
    graded_at timestamp with time zone,
    CONSTRAINT homework_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'late'::text, 'graded'::text, 'resubmit'::text])))
);

ALTER TABLE ONLY public.homework_submissions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.houses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    name text NOT NULL,
    color text DEFAULT '#64748b'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.houses FORCE ROW LEVEL SECURITY;


CREATE TABLE public.institutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    short_name text NOT NULL,
    slug public.citext NOT NULL,
    logo_key text,
    primary_color text DEFAULT '#1e40af'::text NOT NULL,
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    locale text DEFAULT 'en-IN'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT institutions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.institutions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    provider text NOT NULL,
    kind text NOT NULL,
    credentials bytea,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    last_ok_at timestamp with time zone,
    last_error text
);

ALTER TABLE ONLY public.integrations FORCE ROW LEVEL SECURITY;


CREATE TABLE public.invoice_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    fee_head_id uuid NOT NULL,
    description text,
    amount_paise bigint NOT NULL,
    discount_paise bigint DEFAULT 0 NOT NULL,
    CONSTRAINT invoice_lines_amount_paise_check CHECK ((amount_paise >= 0)),
    CONSTRAINT invoice_lines_discount_paise_check CHECK ((discount_paise >= 0))
);

ALTER TABLE ONLY public.invoice_lines FORCE ROW LEVEL SECURITY;


CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    invoice_no text NOT NULL,
    instalment_no integer,
    issued_on date DEFAULT CURRENT_DATE NOT NULL,
    due_on date,
    gross_paise bigint DEFAULT 0 NOT NULL,
    discount_paise bigint DEFAULT 0 NOT NULL,
    fine_paise bigint DEFAULT 0 NOT NULL,
    net_paise bigint GENERATED ALWAYS AS (((gross_paise - discount_paise) + fine_paise)) STORED,
    paid_paise bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'unpaid'::text NOT NULL,
    cancelled_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoices_discount_paise_check CHECK ((discount_paise >= 0)),
    CONSTRAINT invoices_fine_paise_check CHECK ((fine_paise >= 0)),
    CONSTRAINT invoices_gross_paise_check CHECK ((gross_paise >= 0)),
    CONSTRAINT invoices_paid_paise_check CHECK ((paid_paise >= 0)),
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'unpaid'::text, 'partial'::text, 'paid'::text, 'overdue'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.invoices FORCE ROW LEVEL SECURITY;


CREATE TABLE public.issued_certificates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    certificate_type_id uuid NOT NULL,
    student_id uuid,
    employee_id uuid,
    serial_no text NOT NULL,
    issued_on date DEFAULT CURRENT_DATE NOT NULL,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    pdf_file_id uuid,
    status text DEFAULT 'issued'::text NOT NULL,
    requested_by uuid,
    approved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT issued_certificates_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'approved'::text, 'issued'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.issued_certificates FORCE ROW LEVEL SECURITY;


CREATE TABLE public.leave_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    leave_type_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    entitled numeric(5,1) DEFAULT 0 NOT NULL,
    taken numeric(5,1) DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.leave_balances FORCE ROW LEVEL SECURITY;


CREATE TABLE public.leave_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    leave_type_id uuid,
    subject_kind text NOT NULL,
    employee_id uuid,
    student_id uuid,
    from_date date NOT NULL,
    to_date date NOT NULL,
    is_half_day boolean DEFAULT false NOT NULL,
    days numeric(5,1) DEFAULT 1 NOT NULL,
    reason text NOT NULL,
    attachment_file_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    applied_by uuid,
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT leave_requests_check CHECK ((to_date >= from_date)),
    CONSTRAINT leave_requests_check1 CHECK ((((subject_kind = 'staff'::text) AND (employee_id IS NOT NULL) AND (student_id IS NULL)) OR ((subject_kind = 'student'::text) AND (student_id IS NOT NULL) AND (employee_id IS NULL)))),
    CONSTRAINT leave_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT leave_requests_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['staff'::text, 'student'::text])))
);

ALTER TABLE ONLY public.leave_requests FORCE ROW LEVEL SECURITY;


CREATE TABLE public.leave_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    applies_to text DEFAULT 'staff'::text NOT NULL,
    annual_quota numeric(5,1),
    is_paid boolean DEFAULT true NOT NULL,
    carry_forward boolean DEFAULT false NOT NULL,
    CONSTRAINT leave_types_applies_to_check CHECK ((applies_to = ANY (ARRAY['staff'::text, 'student'::text])))
);

ALTER TABLE ONLY public.leave_types FORCE ROW LEVEL SECURITY;


CREATE TABLE public.library_copies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    title_id uuid NOT NULL,
    accession_no text NOT NULL,
    barcode text,
    rack text,
    status text DEFAULT 'available'::text NOT NULL,
    CONSTRAINT library_copies_status_check CHECK ((status = ANY (ARRAY['available'::text, 'issued'::text, 'reserved'::text, 'lost'::text, 'damaged'::text, 'withdrawn'::text])))
);

ALTER TABLE ONLY public.library_copies FORCE ROW LEVEL SECURITY;


CREATE TABLE public.library_loans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    copy_id uuid NOT NULL,
    student_id uuid,
    employee_id uuid,
    issued_on date DEFAULT CURRENT_DATE NOT NULL,
    due_on date NOT NULL,
    returned_on date,
    renewal_count integer DEFAULT 0 NOT NULL,
    fine_paise bigint DEFAULT 0 NOT NULL,
    fine_paid boolean DEFAULT false NOT NULL,
    issued_by uuid,
    CONSTRAINT library_loans_check CHECK ((num_nonnulls(student_id, employee_id) = 1)),
    CONSTRAINT library_loans_fine_paise_check CHECK ((fine_paise >= 0))
);

ALTER TABLE ONLY public.library_loans FORCE ROW LEVEL SECURITY;


CREATE TABLE public.library_titles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    title text NOT NULL,
    author text,
    publisher text,
    isbn text,
    category text,
    edition text,
    language text,
    price_paise bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.library_titles FORCE ROW LEVEL SECURITY;


CREATE TABLE public.marks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    exam_subject_id uuid NOT NULL,
    student_id uuid NOT NULL,
    marks_obtained numeric(6,2),
    grade text,
    is_absent boolean DEFAULT false NOT NULL,
    grace_marks numeric(5,2) DEFAULT 0 NOT NULL,
    remarks text,
    entered_by uuid,
    entered_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT marks_marks_obtained_check CHECK (((marks_obtained IS NULL) OR (marks_obtained >= (0)::numeric)))
);

ALTER TABLE ONLY public.marks FORCE ROW LEVEL SECURITY;


CREATE TABLE public.message_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    channel text NOT NULL,
    template_code text,
    recipient text NOT NULL,
    user_id uuid,
    student_id uuid,
    subject text,
    body text,
    status text DEFAULT 'queued'::text NOT NULL,
    provider text,
    provider_msg_id text,
    error text,
    cost_paise bigint,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    CONSTRAINT message_log_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'whatsapp'::text, 'push'::text, 'in_app'::text]))),
    CONSTRAINT message_log_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'bounced'::text, 'read'::text])))
);

ALTER TABLE ONLY public.message_log FORCE ROW LEVEL SECURITY;


CREATE TABLE public.message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    code text NOT NULL,
    channel text NOT NULL,
    subject text,
    body text NOT NULL,
    dlt_template_id text,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT message_templates_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'whatsapp'::text, 'push'::text, 'in_app'::text])))
);

ALTER TABLE ONLY public.message_templates FORCE ROW LEVEL SECURITY;


CREATE TABLE public.module_settings (
    institution_id uuid NOT NULL,
    module text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.module_settings FORCE ROW LEVEL SECURITY;


CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    user_id uuid NOT NULL,
    student_id uuid,
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    link text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


CREATE TABLE public.numbering_schemes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    kind text NOT NULL,
    prefix text DEFAULT ''::text NOT NULL,
    suffix text DEFAULT ''::text NOT NULL,
    padding integer DEFAULT 5 NOT NULL,
    next_value bigint DEFAULT 1 NOT NULL,
    reset_yearly boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.numbering_schemes FORCE ROW LEVEL SECURITY;


CREATE TABLE public.payment_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    amount_paise bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_allocations_amount_paise_check CHECK ((amount_paise > 0))
);

ALTER TABLE ONLY public.payment_allocations FORCE ROW LEVEL SECURITY;


CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    student_id uuid NOT NULL,
    receipt_no text,
    amount_paise bigint NOT NULL,
    allocated_paise bigint DEFAULT 0 NOT NULL,
    mode text NOT NULL,
    paid_on date DEFAULT CURRENT_DATE NOT NULL,
    reference_no text,
    gateway text,
    gateway_txn_id text,
    gateway_status text,
    bank_name text,
    cheque_date date,
    status text DEFAULT 'success'::text NOT NULL,
    reconciled_at timestamp with time zone,
    reconciled_by uuid,
    collected_by uuid,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payments_allocated_paise_check CHECK ((allocated_paise >= 0)),
    CONSTRAINT payments_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT payments_check CHECK ((allocated_paise <= amount_paise)),
    CONSTRAINT payments_mode_check CHECK ((mode = ANY (ARRAY['cash'::text, 'cheque'::text, 'dd'::text, 'neft'::text, 'upi'::text, 'card'::text, 'netbanking'::text, 'gateway'::text, 'adjustment'::text]))),
    CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text, 'bounced'::text, 'refunded'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.payments FORCE ROW LEVEL SECURITY;


CREATE TABLE public.periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    name text NOT NULL,
    sequence integer NOT NULL,
    starts_at time without time zone NOT NULL,
    ends_at time without time zone NOT NULL,
    is_break boolean DEFAULT false NOT NULL,
    CONSTRAINT periods_check CHECK ((ends_at > starts_at))
);

ALTER TABLE ONLY public.periods FORCE ROW LEVEL SECURITY;


CREATE TABLE public.permissions (
    key text NOT NULL,
    module text NOT NULL,
    description text NOT NULL
);


CREATE TABLE public.plans (
    code text NOT NULL,
    name text NOT NULL,
    price_paise bigint DEFAULT 0 NOT NULL,
    max_students integer,
    max_campuses integer,
    modules text[] DEFAULT '{}'::text[] NOT NULL,
    sequence integer DEFAULT 0 NOT NULL
);


CREATE TABLE public.refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    payment_id uuid,
    amount_paise bigint NOT NULL,
    reason text NOT NULL,
    mode text,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by uuid,
    approved_by uuid,
    processed_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT refunds_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'processed'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.refunds FORCE ROW LEVEL SECURITY;


CREATE TABLE public.report_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    term_id uuid,
    enrollment_id uuid,
    total_marks numeric(8,2),
    max_marks numeric(8,2),
    percentage numeric(5,2),
    grade text,
    gpa numeric(4,2),
    rank_in_section integer,
    rank_in_class integer,
    attendance_percent numeric(5,2),
    class_teacher_remarks text,
    principal_remarks text,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    pdf_file_id uuid,
    is_published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.report_cards FORCE ROW LEVEL SECURITY;


CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_key text NOT NULL
);

ALTER TABLE ONLY public.role_permissions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid,
    key text NOT NULL,
    name text NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


CREATE TABLE public.route_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    route_id uuid NOT NULL,
    name text NOT NULL,
    sequence integer NOT NULL,
    pickup_time time without time zone,
    drop_time time without time zone,
    latitude numeric(9,6),
    longitude numeric(9,6),
    fare_paise bigint,
    CONSTRAINT route_stops_fare_paise_check CHECK (((fare_paise IS NULL) OR (fare_paise >= 0)))
);

ALTER TABLE ONLY public.route_stops FORCE ROW LEVEL SECURITY;


CREATE TABLE public.routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    name text NOT NULL,
    code text,
    vehicle_id uuid,
    distance_km numeric(6,2),
    is_active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.routes FORCE ROW LEVEL SECURITY;


CREATE TABLE public.section_subject_teachers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    section_id uuid NOT NULL,
    class_subject_id uuid NOT NULL,
    teacher_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.section_subject_teachers FORCE ROW LEVEL SECURITY;


CREATE TABLE public.sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    class_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    name text NOT NULL,
    capacity integer DEFAULT 40 NOT NULL,
    class_teacher_id uuid,
    room text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sections_capacity_check CHECK ((capacity > 0))
);

ALTER TABLE ONLY public.sections FORCE ROW LEVEL SECURITY;


CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    ip inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY public.sessions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.staff_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    user_id uuid NOT NULL,
    on_date date NOT NULL,
    status text NOT NULL,
    check_in timestamp with time zone,
    check_out timestamp with time zone,
    source text DEFAULT 'manual'::text NOT NULL,
    device_ref text,
    remarks text,
    marked_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_attendance_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'late'::text, 'half_day'::text, 'leave'::text, 'holiday'::text, 'week_off'::text])))
);

ALTER TABLE ONLY public.staff_attendance FORCE ROW LEVEL SECURITY;


CREATE TABLE public.student_achievements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid,
    kind text DEFAULT 'award'::text NOT NULL,
    title text NOT NULL,
    description text,
    level text,
    "position" text,
    awarded_on date,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT student_achievements_kind_check CHECK ((kind = ANY (ARRAY['award'::text, 'sport'::text, 'club'::text, 'activity'::text, 'competition'::text, 'position'::text]))),
    CONSTRAINT student_achievements_level_check CHECK ((level = ANY (ARRAY['class'::text, 'school'::text, 'district'::text, 'state'::text, 'national'::text, 'international'::text])))
);

ALTER TABLE ONLY public.student_achievements FORCE ROW LEVEL SECURITY;


CREATE TABLE public.student_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    section_id uuid NOT NULL,
    on_date date NOT NULL,
    period_id uuid,
    status text NOT NULL,
    minutes_late integer,
    remarks text,
    marked_by uuid,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    corrected_from text,
    corrected_by uuid,
    corrected_at timestamp with time zone,
    CONSTRAINT student_attendance_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'late'::text, 'half_day'::text, 'leave'::text, 'holiday'::text])))
);

ALTER TABLE ONLY public.student_attendance FORCE ROW LEVEL SECURITY;


CREATE TABLE public.student_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    file_id uuid NOT NULL,
    doc_type text NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.student_documents FORCE ROW LEVEL SECURITY;


CREATE TABLE public.student_guardians (
    student_id uuid NOT NULL,
    guardian_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_emergency boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.student_guardians FORCE ROW LEVEL SECURITY;


CREATE TABLE public.student_health (
    student_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    allergies text,
    chronic_conditions text,
    medications text,
    doctor_name text,
    doctor_phone text,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.student_health FORCE ROW LEVEL SECURITY;


CREATE TABLE public.students (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    admission_no text NOT NULL,
    first_name text NOT NULL,
    middle_name text,
    last_name text,
    date_of_birth date,
    gender text,
    blood_group text,
    category text,
    religion text,
    mother_tongue text,
    nationality text DEFAULT 'Indian'::text NOT NULL,
    house_id uuid,
    photo_file_id uuid,
    aadhaar_last4 text,
    address_line1 text,
    address_line2 text,
    city text,
    state text,
    pincode text,
    admission_date date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    exit_date date,
    exit_reason text,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    CONSTRAINT students_aadhaar_last4_check CHECK ((aadhaar_last4 ~ '^[0-9]{4}$'::text)),
    CONSTRAINT students_category_check CHECK ((category = ANY (ARRAY['general'::text, 'obc'::text, 'sc'::text, 'st'::text, 'ews'::text, 'other'::text]))),
    CONSTRAINT students_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text]))),
    CONSTRAINT students_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'withdrawn'::text, 'transferred'::text, 'graduated'::text, 'alumni'::text])))
);

ALTER TABLE ONLY public.students FORCE ROW LEVEL SECURITY;


CREATE TABLE public.study_materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    class_subject_id uuid,
    section_id uuid,
    title text NOT NULL,
    description text,
    kind text DEFAULT 'note'::text NOT NULL,
    file_id uuid,
    external_url text,
    is_published boolean DEFAULT true NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT study_materials_kind_check CHECK ((kind = ANY (ARRAY['note'::text, 'worksheet'::text, 'reference'::text, 'video'::text, 'link'::text, 'syllabus'::text])))
);

ALTER TABLE ONLY public.study_materials FORCE ROW LEVEL SECURITY;


CREATE TABLE public.subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    is_scholastic boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.subjects FORCE ROW LEVEL SECURITY;


CREATE TABLE public.subscriptions (
    institution_id uuid NOT NULL,
    plan_code text NOT NULL,
    status text DEFAULT 'trial'::text NOT NULL,
    started_on date DEFAULT CURRENT_DATE NOT NULL,
    renews_on date,
    trial_ends_on date,
    licensed_students integer,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['trial'::text, 'active'::text, 'past_due'::text, 'suspended'::text, 'cancelled'::text])))
);


CREATE TABLE public.substitutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    timetable_entry_id uuid NOT NULL,
    on_date date NOT NULL,
    substitute_user_id uuid NOT NULL,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.substitutions FORCE ROW LEVEL SECURITY;


CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    raised_by uuid NOT NULL,
    student_id uuid,
    category text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to uuid,
    resolution text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT support_tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'waiting'::text, 'resolved'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.support_tickets FORCE ROW LEVEL SECURITY;


CREATE TABLE public.terms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    name text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    sequence integer DEFAULT 1 NOT NULL,
    CONSTRAINT terms_check CHECK ((ends_on > starts_on))
);

ALTER TABLE ONLY public.terms FORCE ROW LEVEL SECURITY;


CREATE TABLE public.timetable_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    period_id uuid NOT NULL,
    weekday integer NOT NULL,
    class_subject_id uuid NOT NULL,
    teacher_user_id uuid,
    room text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT timetable_entries_weekday_check CHECK (((weekday >= 1) AND (weekday <= 7)))
);

ALTER TABLE ONLY public.timetable_entries FORCE ROW LEVEL SECURITY;


CREATE TABLE public.transport_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    route_id uuid NOT NULL,
    pickup_stop_id uuid,
    drop_stop_id uuid,
    valid_from date DEFAULT CURRENT_DATE NOT NULL,
    valid_to date
);

ALTER TABLE ONLY public.transport_allocations FORCE ROW LEVEL SECURITY;


CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    campus_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.user_roles FORCE ROW LEVEL SECURITY;


CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid,
    email public.citext,
    phone text,
    full_name text NOT NULL,
    password_hash text,
    avatar_key text,
    status text DEFAULT 'active'::text NOT NULL,
    mfa_secret text,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_check CHECK (((email IS NOT NULL) OR (phone IS NOT NULL))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'invited'::text, 'suspended'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    registration_no text NOT NULL,
    model text,
    capacity integer DEFAULT 40 NOT NULL,
    driver_employee_id uuid,
    attendant_employee_id uuid,
    insurance_expiry date,
    fitness_expiry date,
    permit_expiry date,
    puc_expiry date,
    gps_device_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vehicles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'maintenance'::text, 'retired'::text])))
);

ALTER TABLE ONLY public.vehicles FORCE ROW LEVEL SECURITY;


ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_pkey PRIMARY KEY (announcement_id, user_id, student_id);

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_pkey PRIMARY KEY (announcement_id, section_id);

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_institution_id_application_no_key UNIQUE (institution_id, application_no);

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_institution_id_code_key UNIQUE (institution_id, code);

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.certificate_types
    ADD CONSTRAINT certificate_types_institution_id_code_key UNIQUE (institution_id, code);

ALTER TABLE ONLY public.certificate_types
    ADD CONSTRAINT certificate_types_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_class_id_subject_id_key UNIQUE (class_id, subject_id);

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.designations
    ADD CONSTRAINT designations_institution_id_name_key UNIQUE (institution_id, name);

ALTER TABLE ONLY public.designations
    ADD CONSTRAINT designations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_institution_id_employee_code_key UNIQUE (institution_id, employee_code);

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_exam_id_class_subject_id_key UNIQUE (exam_id, class_subject_id);

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_institution_id_code_key UNIQUE (institution_id, code);

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_fee_structure_id_fee_head_id_instalment_key UNIQUE (fee_structure_id, fee_head_id, instalment_no);

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.grade_bands
    ADD CONSTRAINT grade_bands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_institution_id_name_key UNIQUE (institution_id, name);

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_institution_id_phone_full_name_key UNIQUE (institution_id, phone, full_name);

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_homework_id_student_id_key UNIQUE (homework_id, student_id);

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_institution_id_provider_key UNIQUE (institution_id, provider);

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_institution_id_invoice_no_key UNIQUE (institution_id, invoice_no);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_institution_id_serial_no_key UNIQUE (institution_id, serial_no);

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_employee_id_leave_type_id_academic_year_id_key UNIQUE (employee_id, leave_type_id, academic_year_id);

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_institution_id_code_key UNIQUE (institution_id, code);

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_institution_id_accession_no_key UNIQUE (institution_id, accession_no);

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.library_titles
    ADD CONSTRAINT library_titles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_exam_subject_id_student_id_key UNIQUE (exam_subject_id, student_id);

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_institution_id_code_channel_key UNIQUE (institution_id, code, channel);

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.module_settings
    ADD CONSTRAINT module_settings_pkey PRIMARY KEY (institution_id, module);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_institution_id_campus_id_kind_key UNIQUE (institution_id, campus_id, kind);

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_payment_id_invoice_id_key UNIQUE (payment_id, invoice_id);

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_institution_id_campus_id_sequence_key UNIQUE (institution_id, campus_id, sequence);

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (code);

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_student_id_academic_year_id_term_id_key UNIQUE (student_id, academic_year_id, term_id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_route_id_sequence_key UNIQUE (route_id, sequence);

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_section_id_class_subject_id_key UNIQUE (section_id, class_subject_id);

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_class_id_academic_year_id_name_key UNIQUE (class_id, academic_year_id, name);

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_user_id_on_date_key UNIQUE (user_id, on_date);

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_pkey PRIMARY KEY (student_id, guardian_id);

ALTER TABLE ONLY public.student_health
    ADD CONSTRAINT student_health_pkey PRIMARY KEY (student_id);

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_institution_id_admission_no_key UNIQUE (institution_id, admission_no);

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_institution_id_campus_id_code_key UNIQUE (institution_id, campus_id, code);

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (institution_id);

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_timetable_entry_id_on_date_key UNIQUE (timetable_entry_id, on_date);

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.terms
    ADD CONSTRAINT terms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_id_campus_id_key UNIQUE (user_id, role_id, campus_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_institution_id_registration_no_key UNIQUE (institution_id, registration_no);

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);

CREATE INDEX academic_years_institution_id_campus_id_idx ON public.academic_years USING btree (institution_id, campus_id);

CREATE UNIQUE INDEX academic_years_one_current ON public.academic_years USING btree (institution_id, COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_current;

CREATE INDEX admission_assessments_application_id_idx ON public.admission_assessments USING btree (application_id);

CREATE INDEX admission_assessments_institution_id_scheduled_at_idx ON public.admission_assessments USING btree (institution_id, scheduled_at);

CREATE INDEX admission_sessions_institution_id_campus_id_idx ON public.admission_sessions USING btree (institution_id, campus_id);

CREATE INDEX announcement_acks_institution_id_idx ON public.announcement_acks USING btree (institution_id);

CREATE INDEX announcement_sections_institution_id_idx ON public.announcement_sections USING btree (institution_id);

CREATE INDEX announcements_institution_id_publish_at_idx ON public.announcements USING btree (institution_id, publish_at DESC);

CREATE INDEX application_documents_application_id_idx ON public.application_documents USING btree (application_id);

CREATE INDEX application_documents_institution_id_idx ON public.application_documents USING btree (institution_id);

CREATE INDEX applications_campus_id_class_sought_idx ON public.applications USING btree (campus_id, class_sought);

CREATE INDEX applications_institution_id_status_idx ON public.applications USING btree (institution_id, status);

CREATE UNIQUE INDEX applications_one_student ON public.applications USING btree (student_id) WHERE (student_id IS NOT NULL);

CREATE INDEX attendance_corrections_institution_id_status_idx ON public.attendance_corrections USING btree (institution_id, status);

CREATE INDEX audit_log_entity_type_entity_id_idx ON public.audit_log USING btree (entity_type, entity_id);

CREATE INDEX audit_log_institution_id_created_at_idx ON public.audit_log USING btree (institution_id, created_at DESC);

CREATE INDEX campuses_institution_id_idx ON public.campuses USING btree (institution_id);

CREATE INDEX class_subjects_institution_id_idx ON public.class_subjects USING btree (institution_id);

CREATE INDEX classes_institution_id_campus_id_level_idx ON public.classes USING btree (institution_id, campus_id, level);

CREATE INDEX discipline_records_institution_id_idx ON public.discipline_records USING btree (institution_id);

CREATE INDEX discipline_records_student_id_occurred_on_idx ON public.discipline_records USING btree (student_id, occurred_on DESC);

CREATE INDEX employee_documents_employee_id_idx ON public.employee_documents USING btree (employee_id);

CREATE INDEX employee_documents_institution_id_idx ON public.employee_documents USING btree (institution_id);

CREATE INDEX employees_institution_id_campus_id_status_idx ON public.employees USING btree (institution_id, campus_id, status);

CREATE INDEX employees_user_id_idx ON public.employees USING btree (user_id);

CREATE INDEX enquiries_institution_id_status_next_follow_up_idx ON public.enquiries USING btree (institution_id, status, next_follow_up);

CREATE INDEX enquiries_phone_idx ON public.enquiries USING btree (phone);

CREATE INDEX enrollments_institution_id_academic_year_id_idx ON public.enrollments USING btree (institution_id, academic_year_id);

CREATE UNIQUE INDEX enrollments_roll_no_unique ON public.enrollments USING btree (section_id, roll_no) WHERE (roll_no IS NOT NULL);

CREATE INDEX enrollments_section_id_status_idx ON public.enrollments USING btree (section_id, status);

CREATE INDEX exam_subjects_institution_id_idx ON public.exam_subjects USING btree (institution_id);

CREATE INDEX exams_institution_id_academic_year_id_idx ON public.exams USING btree (institution_id, academic_year_id);

CREATE INDEX fee_concessions_institution_id_idx ON public.fee_concessions USING btree (institution_id);

CREATE INDEX fee_concessions_student_id_academic_year_id_idx ON public.fee_concessions USING btree (student_id, academic_year_id);

CREATE INDEX fee_structure_items_institution_id_idx ON public.fee_structure_items USING btree (institution_id);

CREATE INDEX fee_structures_institution_id_academic_year_id_class_id_idx ON public.fee_structures USING btree (institution_id, academic_year_id, class_id);

CREATE INDEX files_institution_id_owner_type_owner_id_idx ON public.files USING btree (institution_id, owner_type, owner_id);

CREATE INDEX grade_bands_grading_scale_id_idx ON public.grade_bands USING btree (grading_scale_id);

CREATE INDEX grade_bands_institution_id_idx ON public.grade_bands USING btree (institution_id);

CREATE INDEX guardians_institution_id_idx ON public.guardians USING btree (institution_id);

CREATE INDEX guardians_user_id_idx ON public.guardians USING btree (user_id);

CREATE INDEX guardians_user_lookup ON public.guardians USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX holidays_institution_id_on_date_idx ON public.holidays USING btree (institution_id, on_date);

CREATE INDEX homework_attachments_homework_id_idx ON public.homework_attachments USING btree (homework_id);

CREATE INDEX homework_attachments_institution_id_idx ON public.homework_attachments USING btree (institution_id);

CREATE INDEX homework_institution_id_assigned_on_idx ON public.homework USING btree (institution_id, assigned_on);

CREATE INDEX homework_section_id_due_on_idx ON public.homework USING btree (section_id, due_on);

CREATE INDEX homework_submissions_institution_id_idx ON public.homework_submissions USING btree (institution_id);

CREATE INDEX homework_submissions_student_id_status_idx ON public.homework_submissions USING btree (student_id, status);

CREATE INDEX invoice_lines_institution_id_idx ON public.invoice_lines USING btree (institution_id);

CREATE INDEX invoice_lines_invoice_id_idx ON public.invoice_lines USING btree (invoice_id);

CREATE INDEX invoices_institution_id_status_due_on_idx ON public.invoices USING btree (institution_id, status, due_on);

CREATE INDEX invoices_student_id_academic_year_id_idx ON public.invoices USING btree (student_id, academic_year_id);

CREATE INDEX issued_certificates_institution_id_status_idx ON public.issued_certificates USING btree (institution_id, status);

CREATE INDEX issued_certificates_student_id_idx ON public.issued_certificates USING btree (student_id);

CREATE INDEX leave_balances_institution_id_idx ON public.leave_balances USING btree (institution_id);

CREATE INDEX leave_requests_employee_id_from_date_idx ON public.leave_requests USING btree (employee_id, from_date);

CREATE INDEX leave_requests_institution_id_status_idx ON public.leave_requests USING btree (institution_id, status);

CREATE INDEX leave_requests_student_id_from_date_idx ON public.leave_requests USING btree (student_id, from_date);

CREATE INDEX library_copies_title_id_status_idx ON public.library_copies USING btree (title_id, status);

CREATE UNIQUE INDEX library_copy_active_loan ON public.library_loans USING btree (copy_id) WHERE (returned_on IS NULL);

CREATE INDEX library_loans_institution_id_due_on_idx ON public.library_loans USING btree (institution_id, due_on) WHERE (returned_on IS NULL);

CREATE INDEX library_loans_student_id_idx ON public.library_loans USING btree (student_id);

CREATE INDEX library_titles_institution_id_campus_id_idx ON public.library_titles USING btree (institution_id, campus_id);

CREATE INDEX library_titles_isbn_idx ON public.library_titles USING btree (isbn);

CREATE INDEX marks_institution_id_exam_subject_id_idx ON public.marks USING btree (institution_id, exam_subject_id);

CREATE INDEX marks_student_id_idx ON public.marks USING btree (student_id);

CREATE INDEX message_log_institution_id_queued_at_idx ON public.message_log USING btree (institution_id, queued_at DESC);

CREATE INDEX message_log_status_idx ON public.message_log USING btree (status) WHERE (status = ANY (ARRAY['queued'::text, 'failed'::text]));

CREATE INDEX message_log_student_id_idx ON public.message_log USING btree (student_id);

CREATE INDEX notifications_institution_id_idx ON public.notifications USING btree (institution_id);

CREATE INDEX notifications_user_id_read_at_created_at_idx ON public.notifications USING btree (user_id, read_at, created_at DESC);

CREATE INDEX payment_allocations_institution_id_idx ON public.payment_allocations USING btree (institution_id);

CREATE INDEX payment_allocations_invoice_id_idx ON public.payment_allocations USING btree (invoice_id);

CREATE UNIQUE INDEX payments_gateway_txn ON public.payments USING btree (gateway, gateway_txn_id) WHERE (gateway_txn_id IS NOT NULL);

CREATE INDEX payments_institution_id_paid_on_status_idx ON public.payments USING btree (institution_id, paid_on, status);

CREATE UNIQUE INDEX payments_receipt_no ON public.payments USING btree (institution_id, receipt_no) WHERE (receipt_no IS NOT NULL);

CREATE INDEX payments_student_id_paid_on_idx ON public.payments USING btree (student_id, paid_on);

CREATE INDEX refunds_institution_id_status_idx ON public.refunds USING btree (institution_id, status);

CREATE INDEX refunds_student_id_idx ON public.refunds USING btree (student_id);

CREATE INDEX report_cards_institution_id_academic_year_id_idx ON public.report_cards USING btree (institution_id, academic_year_id);

CREATE UNIQUE INDEX roles_institution_key ON public.roles USING btree (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE INDEX route_stops_institution_id_idx ON public.route_stops USING btree (institution_id);

CREATE INDEX section_subject_teachers_institution_id_idx ON public.section_subject_teachers USING btree (institution_id);

CREATE INDEX section_subject_teachers_teacher_user_id_idx ON public.section_subject_teachers USING btree (teacher_user_id);

CREATE INDEX sections_class_teacher_id_idx ON public.sections USING btree (class_teacher_id);

CREATE INDEX sections_institution_id_academic_year_id_idx ON public.sections USING btree (institution_id, academic_year_id);

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at) WHERE (revoked_at IS NULL);

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE INDEX staff_attendance_institution_id_on_date_idx ON public.staff_attendance USING btree (institution_id, on_date);

CREATE INDEX student_achievements_institution_id_idx ON public.student_achievements USING btree (institution_id);

CREATE INDEX student_achievements_student_id_idx ON public.student_achievements USING btree (student_id);

CREATE UNIQUE INDEX student_attendance_daily ON public.student_attendance USING btree (student_id, on_date) WHERE (period_id IS NULL);

CREATE INDEX student_attendance_institution_id_on_date_status_idx ON public.student_attendance USING btree (institution_id, on_date, status);

CREATE UNIQUE INDEX student_attendance_period ON public.student_attendance USING btree (student_id, on_date, period_id) WHERE (period_id IS NOT NULL);

CREATE INDEX student_attendance_section_id_on_date_idx ON public.student_attendance USING btree (section_id, on_date);

CREATE INDEX student_documents_institution_id_idx ON public.student_documents USING btree (institution_id);

CREATE INDEX student_documents_student_id_idx ON public.student_documents USING btree (student_id);

CREATE INDEX student_guardians_guardian_id_idx ON public.student_guardians USING btree (guardian_id);

CREATE INDEX student_guardians_institution_id_idx ON public.student_guardians USING btree (institution_id);

CREATE UNIQUE INDEX student_guardians_one_primary ON public.student_guardians USING btree (student_id) WHERE is_primary;

CREATE INDEX student_health_institution_id_idx ON public.student_health USING btree (institution_id);

CREATE INDEX students_institution_id_campus_id_status_idx ON public.students USING btree (institution_id, campus_id, status);

CREATE INDEX students_institution_id_last_name_first_name_idx ON public.students USING btree (institution_id, last_name, first_name);

CREATE INDEX students_search ON public.students USING gin (to_tsvector('simple'::regconfig, ((((((COALESCE(first_name, ''::text) || ' '::text) || COALESCE(middle_name, ''::text)) || ' '::text) || COALESCE(last_name, ''::text)) || ' '::text) || admission_no)));

CREATE UNIQUE INDEX students_user_id_unique ON public.students USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX study_materials_institution_id_idx ON public.study_materials USING btree (institution_id);

CREATE INDEX study_materials_section_id_is_published_idx ON public.study_materials USING btree (section_id, is_published);

CREATE INDEX subscriptions_status_idx ON public.subscriptions USING btree (status);

CREATE INDEX substitutions_institution_id_on_date_idx ON public.substitutions USING btree (institution_id, on_date);

CREATE INDEX substitutions_substitute_user_id_on_date_idx ON public.substitutions USING btree (substitute_user_id, on_date);

CREATE INDEX support_tickets_institution_id_status_idx ON public.support_tickets USING btree (institution_id, status);

CREATE INDEX support_tickets_raised_by_idx ON public.support_tickets USING btree (raised_by);

CREATE INDEX terms_academic_year_id_idx ON public.terms USING btree (academic_year_id);

CREATE INDEX timetable_entries_institution_id_academic_year_id_idx ON public.timetable_entries USING btree (institution_id, academic_year_id);

CREATE UNIQUE INDEX timetable_section_slot ON public.timetable_entries USING btree (section_id, weekday, period_id);

CREATE UNIQUE INDEX timetable_teacher_slot ON public.timetable_entries USING btree (teacher_user_id, weekday, period_id, academic_year_id) WHERE (teacher_user_id IS NOT NULL);

CREATE INDEX transport_allocations_institution_id_idx ON public.transport_allocations USING btree (institution_id);

CREATE INDEX transport_allocations_route_id_idx ON public.transport_allocations USING btree (route_id);

CREATE INDEX user_roles_user_id_idx ON public.user_roles USING btree (user_id);

CREATE UNIQUE INDEX users_institution_email ON public.users USING btree (institution_id, email) WHERE (email IS NOT NULL);

CREATE UNIQUE INDEX users_institution_phone ON public.users USING btree (institution_id, phone) WHERE (phone IS NOT NULL);

CREATE UNIQUE INDEX users_platform_email ON public.users USING btree (email) WHERE (institution_id IS NULL);

CREATE INDEX vehicles_institution_id_campus_id_idx ON public.vehicles USING btree (institution_id, campus_id);

CREATE TRIGGER applications_touch BEFORE UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER campuses_touch BEFORE UPDATE ON public.campuses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER employees_touch BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER enquiries_touch BEFORE UPDATE ON public.enquiries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER homework_touch BEFORE UPDATE ON public.homework FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER institutions_touch BEFORE UPDATE ON public.institutions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER invoices_touch BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER payment_allocations_sync AFTER INSERT OR DELETE OR UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_paid();

CREATE TRIGGER payment_allocations_sync_payment AFTER INSERT OR DELETE OR UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION public.sync_payment_allocated();

CREATE TRIGGER students_touch BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER support_tickets_touch BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_conducted_by_fkey FOREIGN KEY (conducted_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_attachment_file_id_fkey FOREIGN KEY (attachment_file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_admission_session_id_fkey FOREIGN KEY (admission_session_id) REFERENCES public.admission_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_class_sought_fkey FOREIGN KEY (class_sought) REFERENCES public.classes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES public.enquiries(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES public.student_attendance(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.certificate_types
    ADD CONSTRAINT certificate_types_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_head_user_id_fkey FOREIGN KEY (head_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.designations
    ADD CONSTRAINT designations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES public.designations(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_photo_file_id_fkey FOREIGN KEY (photo_file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_class_sought_fkey FOREIGN KEY (class_sought) REFERENCES public.classes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_promoted_from_id_fkey FOREIGN KEY (promoted_from_id) REFERENCES public.enrollments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.exams(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_grading_scale_id_fkey FOREIGN KEY (grading_scale_id) REFERENCES public.grading_scales(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_term_id_fkey FOREIGN KEY (term_id) REFERENCES public.terms(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_fee_head_id_fkey FOREIGN KEY (fee_head_id) REFERENCES public.fee_heads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_fee_head_id_fkey FOREIGN KEY (fee_head_id) REFERENCES public.fee_heads(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_fee_structure_id_fkey FOREIGN KEY (fee_structure_id) REFERENCES public.fee_structures(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.grade_bands
    ADD CONSTRAINT grade_bands_grading_scale_id_fkey FOREIGN KEY (grading_scale_id) REFERENCES public.grading_scales(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.grade_bands
    ADD CONSTRAINT grade_bands_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_homework_id_fkey FOREIGN KEY (homework_id) REFERENCES public.homework(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_graded_by_fkey FOREIGN KEY (graded_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_homework_id_fkey FOREIGN KEY (homework_id) REFERENCES public.homework(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_fee_head_id_fkey FOREIGN KEY (fee_head_id) REFERENCES public.fee_heads(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_certificate_type_id_fkey FOREIGN KEY (certificate_type_id) REFERENCES public.certificate_types(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_pdf_file_id_fkey FOREIGN KEY (pdf_file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_attachment_file_id_fkey FOREIGN KEY (attachment_file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_title_id_fkey FOREIGN KEY (title_id) REFERENCES public.library_titles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_copy_id_fkey FOREIGN KEY (copy_id) REFERENCES public.library_copies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_titles
    ADD CONSTRAINT library_titles_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_titles
    ADD CONSTRAINT library_titles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_exam_subject_id_fkey FOREIGN KEY (exam_subject_id) REFERENCES public.exam_subjects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.module_settings
    ADD CONSTRAINT module_settings_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_collected_by_fkey FOREIGN KEY (collected_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_reconciled_by_fkey FOREIGN KEY (reconciled_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.enrollments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_pdf_file_id_fkey FOREIGN KEY (pdf_file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_term_id_fkey FOREIGN KEY (term_id) REFERENCES public.terms(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_teacher_user_id_fkey FOREIGN KEY (teacher_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_class_teacher_id_fkey FOREIGN KEY (class_teacher_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.periods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES public.guardians(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_health
    ADD CONSTRAINT student_health_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.student_health
    ADD CONSTRAINT student_health_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_house_id_fkey FOREIGN KEY (house_id) REFERENCES public.houses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_photo_file_id_fkey FOREIGN KEY (photo_file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_code_fkey FOREIGN KEY (plan_code) REFERENCES public.plans(code) ON DELETE RESTRICT;

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_substitute_user_id_fkey FOREIGN KEY (substitute_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_timetable_entry_id_fkey FOREIGN KEY (timetable_entry_id) REFERENCES public.timetable_entries(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.terms
    ADD CONSTRAINT terms_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.terms
    ADD CONSTRAINT terms_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.periods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_teacher_user_id_fkey FOREIGN KEY (teacher_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_drop_stop_id_fkey FOREIGN KEY (drop_stop_id) REFERENCES public.route_stops(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_pickup_stop_id_fkey FOREIGN KEY (pickup_stop_id) REFERENCES public.route_stops(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_attendant_employee_id_fkey FOREIGN KEY (attendant_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_driver_employee_id_fkey FOREIGN KEY (driver_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;

ALTER TABLE public.academic_years ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.admission_assessments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.admission_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.announcement_acks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.announcement_sections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.application_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.attendance_corrections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.campuses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.certificate_types ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.class_subjects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.designations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.discipline_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.exam_subjects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fee_concessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fee_heads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fee_structure_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fee_structures ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.grade_bands ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.grading_scales ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.guardians ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.homework ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.homework_attachments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.homework_submissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.houses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.issued_certificates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.library_copies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.library_loans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.library_titles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.marks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.message_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.module_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.numbering_schemes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.report_cards ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.section_subject_teachers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.staff_attendance ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.student_achievements ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.student_attendance ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.student_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.student_guardians ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.student_health ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.study_materials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.substitutions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.academic_years USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.admission_assessments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.admission_sessions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.announcement_acks USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.announcement_sections USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.announcements USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.application_documents USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.applications USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.attendance_corrections USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.audit_log USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.campuses USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.certificate_types USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.class_subjects USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.classes USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.departments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.designations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.discipline_records USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.employee_documents USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.employees USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.enquiries USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.enrollments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.exam_subjects USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.exams USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.fee_concessions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.fee_heads USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.fee_structure_items USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.fee_structures USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.files USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.grade_bands USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.grading_scales USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.guardians USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.holidays USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.homework USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.homework_attachments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.homework_submissions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.houses USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.institutions USING ((public.app_is_platform_admin() OR (id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.integrations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.invoice_lines USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.invoices USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.issued_certificates USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.leave_balances USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.leave_requests USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.leave_types USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.library_copies USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.library_loans USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.library_titles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.marks USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.message_log USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.message_templates USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.module_settings USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.notifications USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.numbering_schemes USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.payment_allocations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.payments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.periods USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.refunds USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.report_cards USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.role_permissions USING ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE (r.id = role_permissions.role_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND (public.app_is_platform_admin() OR (r.institution_id = public.app_current_institution()))))));

CREATE POLICY tenant_isolation ON public.roles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()) OR (institution_id IS NULL))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.route_stops USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.routes USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.section_subject_teachers USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.sections USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.sessions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.staff_attendance USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.student_achievements USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.student_attendance USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.student_documents USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.student_guardians USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.student_health USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.students USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.study_materials USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.subjects USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.substitutions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.support_tickets USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.terms USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.timetable_entries USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.transport_allocations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.user_roles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.users USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

CREATE POLICY tenant_isolation ON public.vehicles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));

ALTER TABLE public.terms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.timetable_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.transport_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

































































































ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO app_user;

-- +goose Down
-- +goose StatementBegin
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- +goose StatementEnd
