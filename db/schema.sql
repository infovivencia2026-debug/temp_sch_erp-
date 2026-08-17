--
-- PostgreSQL database dump
--

\restrict QWqpEFhubueEEoXfu6Xgf4xgjmQXA6Ga9sfx41jqbphGSwpNitAXG4lOLcIhaoQ

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: app_current_institution(); Type: FUNCTION; Schema: public; Owner: erp_owner
--

CREATE FUNCTION public.app_current_institution() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    SELECT NULLIF(current_setting('app.institution_id', true), '')::uuid;
$$;


ALTER FUNCTION public.app_current_institution() OWNER TO erp_owner;

--
-- Name: app_is_platform_admin(); Type: FUNCTION; Schema: public; Owner: erp_owner
--

CREATE FUNCTION public.app_is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(NULLIF(current_setting('app.is_platform_admin', true), ''), 'off') = 'on';
$$;


ALTER FUNCTION public.app_is_platform_admin() OWNER TO erp_owner;

--
-- Name: sync_invoice_paid(); Type: FUNCTION; Schema: public; Owner: erp_owner
--

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


ALTER FUNCTION public.sync_invoice_paid() OWNER TO erp_owner;

--
-- Name: sync_payment_allocated(); Type: FUNCTION; Schema: public; Owner: erp_owner
--

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


ALTER FUNCTION public.sync_payment_allocated() OWNER TO erp_owner;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: erp_owner
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;


ALTER FUNCTION public.touch_updated_at() OWNER TO erp_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: academic_years; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.academic_years OWNER TO erp_owner;

--
-- Name: admission_assessments; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.admission_assessments OWNER TO erp_owner;

--
-- Name: admission_sessions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.admission_sessions OWNER TO erp_owner;

--
-- Name: announcement_acks; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.announcement_acks (
    announcement_id uuid NOT NULL,
    user_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    student_id uuid NOT NULL,
    acked_at timestamp with time zone DEFAULT now() NOT NULL,
    response text
);

ALTER TABLE ONLY public.announcement_acks FORCE ROW LEVEL SECURITY;


ALTER TABLE public.announcement_acks OWNER TO erp_owner;

--
-- Name: announcement_sections; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.announcement_sections (
    announcement_id uuid NOT NULL,
    section_id uuid NOT NULL,
    institution_id uuid NOT NULL
);

ALTER TABLE ONLY public.announcement_sections FORCE ROW LEVEL SECURITY;


ALTER TABLE public.announcement_sections OWNER TO erp_owner;

--
-- Name: announcements; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.announcements OWNER TO erp_owner;

--
-- Name: application_documents; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.application_documents OWNER TO erp_owner;

--
-- Name: applications; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.applications OWNER TO erp_owner;

--
-- Name: attendance_corrections; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.attendance_corrections OWNER TO erp_owner;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.audit_log OWNER TO erp_owner;

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: erp_owner
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_log_id_seq OWNER TO erp_owner;

--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: erp_owner
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: campuses; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.campuses OWNER TO erp_owner;

--
-- Name: certificate_types; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.certificate_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    template_html text,
    requires_approval boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.certificate_types FORCE ROW LEVEL SECURITY;


ALTER TABLE public.certificate_types OWNER TO erp_owner;

--
-- Name: class_subjects; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.class_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    class_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    is_elective boolean DEFAULT false NOT NULL,
    max_marks integer DEFAULT 100 NOT NULL
);

ALTER TABLE ONLY public.class_subjects FORCE ROW LEVEL SECURITY;


ALTER TABLE public.class_subjects OWNER TO erp_owner;

--
-- Name: classes; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.classes OWNER TO erp_owner;

--
-- Name: departments; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    name text NOT NULL,
    head_user_id uuid
);

ALTER TABLE ONLY public.departments FORCE ROW LEVEL SECURITY;


ALTER TABLE public.departments OWNER TO erp_owner;

--
-- Name: designations; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.designations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    name text NOT NULL,
    category text,
    CONSTRAINT designations_category_check CHECK ((category = ANY (ARRAY['teaching'::text, 'non_teaching'::text, 'support'::text, 'management'::text])))
);

ALTER TABLE ONLY public.designations FORCE ROW LEVEL SECURITY;


ALTER TABLE public.designations OWNER TO erp_owner;

--
-- Name: discipline_records; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.discipline_records OWNER TO erp_owner;

--
-- Name: employee_documents; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.employee_documents OWNER TO erp_owner;

--
-- Name: employees; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.employees OWNER TO erp_owner;

--
-- Name: enquiries; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.enquiries OWNER TO erp_owner;

--
-- Name: enrollments; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.enrollments OWNER TO erp_owner;

--
-- Name: exam_subjects; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.exam_subjects OWNER TO erp_owner;

--
-- Name: exams; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.exams OWNER TO erp_owner;

--
-- Name: fee_concessions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.fee_concessions OWNER TO erp_owner;

--
-- Name: fee_heads; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.fee_heads OWNER TO erp_owner;

--
-- Name: fee_structure_items; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.fee_structure_items OWNER TO erp_owner;

--
-- Name: fee_structures; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.fee_structures OWNER TO erp_owner;

--
-- Name: files; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.files OWNER TO erp_owner;

--
-- Name: goose_db_version; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.goose_db_version (
    id integer NOT NULL,
    version_id bigint NOT NULL,
    is_applied boolean NOT NULL,
    tstamp timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.goose_db_version OWNER TO erp_owner;

--
-- Name: goose_db_version_id_seq; Type: SEQUENCE; Schema: public; Owner: erp_owner
--

ALTER TABLE public.goose_db_version ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.goose_db_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: grade_bands; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.grade_bands OWNER TO erp_owner;

--
-- Name: grading_scales; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.grading_scales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.grading_scales FORCE ROW LEVEL SECURITY;


ALTER TABLE public.grading_scales OWNER TO erp_owner;

--
-- Name: guardians; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.guardians OWNER TO erp_owner;

--
-- Name: holidays; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.holidays OWNER TO erp_owner;

--
-- Name: homework; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.homework OWNER TO erp_owner;

--
-- Name: homework_attachments; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.homework_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    homework_id uuid NOT NULL,
    file_id uuid NOT NULL
);

ALTER TABLE ONLY public.homework_attachments FORCE ROW LEVEL SECURITY;


ALTER TABLE public.homework_attachments OWNER TO erp_owner;

--
-- Name: homework_submissions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.homework_submissions OWNER TO erp_owner;

--
-- Name: houses; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.houses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    campus_id uuid,
    name text NOT NULL,
    color text DEFAULT '#64748b'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.houses FORCE ROW LEVEL SECURITY;


ALTER TABLE public.houses OWNER TO erp_owner;

--
-- Name: institutions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.institutions OWNER TO erp_owner;

--
-- Name: integrations; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.integrations OWNER TO erp_owner;

--
-- Name: invoice_lines; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.invoice_lines OWNER TO erp_owner;

--
-- Name: invoices; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.invoices OWNER TO erp_owner;

--
-- Name: issued_certificates; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.issued_certificates OWNER TO erp_owner;

--
-- Name: leave_balances; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.leave_balances OWNER TO erp_owner;

--
-- Name: leave_requests; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.leave_requests OWNER TO erp_owner;

--
-- Name: leave_types; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.leave_types OWNER TO erp_owner;

--
-- Name: library_copies; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.library_copies OWNER TO erp_owner;

--
-- Name: library_loans; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.library_loans OWNER TO erp_owner;

--
-- Name: library_titles; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.library_titles OWNER TO erp_owner;

--
-- Name: marks; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.marks OWNER TO erp_owner;

--
-- Name: message_log; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.message_log OWNER TO erp_owner;

--
-- Name: message_templates; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.message_templates OWNER TO erp_owner;

--
-- Name: module_settings; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.module_settings (
    institution_id uuid NOT NULL,
    module text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.module_settings FORCE ROW LEVEL SECURITY;


ALTER TABLE public.module_settings OWNER TO erp_owner;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.notifications OWNER TO erp_owner;

--
-- Name: numbering_schemes; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.numbering_schemes OWNER TO erp_owner;

--
-- Name: payment_allocations; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.payment_allocations OWNER TO erp_owner;

--
-- Name: payments; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.payments OWNER TO erp_owner;

--
-- Name: periods; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.periods OWNER TO erp_owner;

--
-- Name: permissions; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.permissions (
    key text NOT NULL,
    module text NOT NULL,
    description text NOT NULL
);


ALTER TABLE public.permissions OWNER TO erp_owner;

--
-- Name: plans; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.plans (
    code text NOT NULL,
    name text NOT NULL,
    price_paise bigint DEFAULT 0 NOT NULL,
    max_students integer,
    max_campuses integer,
    modules text[] DEFAULT '{}'::text[] NOT NULL,
    sequence integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.plans OWNER TO erp_owner;

--
-- Name: refunds; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.refunds OWNER TO erp_owner;

--
-- Name: report_cards; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.report_cards OWNER TO erp_owner;

--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_key text NOT NULL
);

ALTER TABLE ONLY public.role_permissions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.role_permissions OWNER TO erp_owner;

--
-- Name: roles; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid,
    key text NOT NULL,
    name text NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


ALTER TABLE public.roles OWNER TO erp_owner;

--
-- Name: route_stops; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.route_stops OWNER TO erp_owner;

--
-- Name: routes; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.routes OWNER TO erp_owner;

--
-- Name: section_subject_teachers; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.section_subject_teachers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid NOT NULL,
    section_id uuid NOT NULL,
    class_subject_id uuid NOT NULL,
    teacher_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.section_subject_teachers FORCE ROW LEVEL SECURITY;


ALTER TABLE public.section_subject_teachers OWNER TO erp_owner;

--
-- Name: sections; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.sections OWNER TO erp_owner;

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.sessions OWNER TO erp_owner;

--
-- Name: staff_attendance; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.staff_attendance OWNER TO erp_owner;

--
-- Name: student_achievements; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.student_achievements OWNER TO erp_owner;

--
-- Name: student_attendance; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.student_attendance OWNER TO erp_owner;

--
-- Name: student_documents; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.student_documents OWNER TO erp_owner;

--
-- Name: student_guardians; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.student_guardians (
    student_id uuid NOT NULL,
    guardian_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_emergency boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.student_guardians FORCE ROW LEVEL SECURITY;


ALTER TABLE public.student_guardians OWNER TO erp_owner;

--
-- Name: student_health; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.student_health OWNER TO erp_owner;

--
-- Name: students; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.students OWNER TO erp_owner;

--
-- Name: study_materials; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.study_materials OWNER TO erp_owner;

--
-- Name: subjects; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.subjects OWNER TO erp_owner;

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.subscriptions OWNER TO erp_owner;

--
-- Name: substitutions; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.substitutions OWNER TO erp_owner;

--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.support_tickets OWNER TO erp_owner;

--
-- Name: terms; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.terms OWNER TO erp_owner;

--
-- Name: timetable_entries; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.timetable_entries OWNER TO erp_owner;

--
-- Name: transport_allocations; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.transport_allocations OWNER TO erp_owner;

--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: erp_owner
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    institution_id uuid,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    campus_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.user_roles FORCE ROW LEVEL SECURITY;


ALTER TABLE public.user_roles OWNER TO erp_owner;

--
-- Name: users; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.users OWNER TO erp_owner;

--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: erp_owner
--

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


ALTER TABLE public.vehicles OWNER TO erp_owner;

--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: academic_years academic_years_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_pkey PRIMARY KEY (id);


--
-- Name: admission_assessments admission_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_pkey PRIMARY KEY (id);


--
-- Name: admission_sessions admission_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_pkey PRIMARY KEY (id);


--
-- Name: announcement_acks announcement_acks_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_pkey PRIMARY KEY (announcement_id, user_id, student_id);


--
-- Name: announcement_sections announcement_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_pkey PRIMARY KEY (announcement_id, section_id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: application_documents application_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_pkey PRIMARY KEY (id);


--
-- Name: applications applications_institution_id_application_no_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_institution_id_application_no_key UNIQUE (institution_id, application_no);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: attendance_corrections attendance_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: campuses campuses_institution_id_code_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_institution_id_code_key UNIQUE (institution_id, code);


--
-- Name: campuses campuses_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_pkey PRIMARY KEY (id);


--
-- Name: certificate_types certificate_types_institution_id_code_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.certificate_types
    ADD CONSTRAINT certificate_types_institution_id_code_key UNIQUE (institution_id, code);


--
-- Name: certificate_types certificate_types_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.certificate_types
    ADD CONSTRAINT certificate_types_pkey PRIMARY KEY (id);


--
-- Name: class_subjects class_subjects_class_id_subject_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_class_id_subject_id_key UNIQUE (class_id, subject_id);


--
-- Name: class_subjects class_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_pkey PRIMARY KEY (id);


--
-- Name: classes classes_institution_id_campus_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);


--
-- Name: classes classes_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (id);


--
-- Name: departments departments_institution_id_campus_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: designations designations_institution_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.designations
    ADD CONSTRAINT designations_institution_id_name_key UNIQUE (institution_id, name);


--
-- Name: designations designations_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.designations
    ADD CONSTRAINT designations_pkey PRIMARY KEY (id);


--
-- Name: discipline_records discipline_records_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_pkey PRIMARY KEY (id);


--
-- Name: employee_documents employee_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_pkey PRIMARY KEY (id);


--
-- Name: employees employees_institution_id_employee_code_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_institution_id_employee_code_key UNIQUE (institution_id, employee_code);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: enquiries enquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);


--
-- Name: enrollments enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id);


--
-- Name: enrollments enrollments_student_id_academic_year_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);


--
-- Name: exam_subjects exam_subjects_exam_id_class_subject_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_exam_id_class_subject_id_key UNIQUE (exam_id, class_subject_id);


--
-- Name: exam_subjects exam_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_pkey PRIMARY KEY (id);


--
-- Name: exams exams_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_pkey PRIMARY KEY (id);


--
-- Name: fee_concessions fee_concessions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_pkey PRIMARY KEY (id);


--
-- Name: fee_heads fee_heads_institution_id_code_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_institution_id_code_key UNIQUE (institution_id, code);


--
-- Name: fee_heads fee_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_pkey PRIMARY KEY (id);


--
-- Name: fee_structure_items fee_structure_items_fee_structure_id_fee_head_id_instalment_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_fee_structure_id_fee_head_id_instalment_key UNIQUE (fee_structure_id, fee_head_id, instalment_no);


--
-- Name: fee_structure_items fee_structure_items_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_pkey PRIMARY KEY (id);


--
-- Name: fee_structures fee_structures_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_pkey PRIMARY KEY (id);


--
-- Name: files files_object_key_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_object_key_key UNIQUE (object_key);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: goose_db_version goose_db_version_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.goose_db_version
    ADD CONSTRAINT goose_db_version_pkey PRIMARY KEY (id);


--
-- Name: grade_bands grade_bands_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.grade_bands
    ADD CONSTRAINT grade_bands_pkey PRIMARY KEY (id);


--
-- Name: grading_scales grading_scales_institution_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_institution_id_name_key UNIQUE (institution_id, name);


--
-- Name: grading_scales grading_scales_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_pkey PRIMARY KEY (id);


--
-- Name: guardians guardians_institution_id_phone_full_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_institution_id_phone_full_name_key UNIQUE (institution_id, phone, full_name);


--
-- Name: guardians guardians_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_pkey PRIMARY KEY (id);


--
-- Name: holidays holidays_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_pkey PRIMARY KEY (id);


--
-- Name: homework_attachments homework_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_pkey PRIMARY KEY (id);


--
-- Name: homework homework_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_pkey PRIMARY KEY (id);


--
-- Name: homework_submissions homework_submissions_homework_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_homework_id_student_id_key UNIQUE (homework_id, student_id);


--
-- Name: homework_submissions homework_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_pkey PRIMARY KEY (id);


--
-- Name: houses houses_institution_id_campus_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);


--
-- Name: houses houses_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_pkey PRIMARY KEY (id);


--
-- Name: institutions institutions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_pkey PRIMARY KEY (id);


--
-- Name: institutions institutions_slug_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_slug_key UNIQUE (slug);


--
-- Name: integrations integrations_institution_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_institution_id_provider_key UNIQUE (institution_id, provider);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: invoice_lines invoice_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_institution_id_invoice_no_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_institution_id_invoice_no_key UNIQUE (institution_id, invoice_no);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: issued_certificates issued_certificates_institution_id_serial_no_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_institution_id_serial_no_key UNIQUE (institution_id, serial_no);


--
-- Name: issued_certificates issued_certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_pkey PRIMARY KEY (id);


--
-- Name: leave_balances leave_balances_employee_id_leave_type_id_academic_year_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_employee_id_leave_type_id_academic_year_id_key UNIQUE (employee_id, leave_type_id, academic_year_id);


--
-- Name: leave_balances leave_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_pkey PRIMARY KEY (id);


--
-- Name: leave_requests leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);


--
-- Name: leave_types leave_types_institution_id_code_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_institution_id_code_key UNIQUE (institution_id, code);


--
-- Name: leave_types leave_types_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);


--
-- Name: library_copies library_copies_institution_id_accession_no_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_institution_id_accession_no_key UNIQUE (institution_id, accession_no);


--
-- Name: library_copies library_copies_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_pkey PRIMARY KEY (id);


--
-- Name: library_loans library_loans_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_pkey PRIMARY KEY (id);


--
-- Name: library_titles library_titles_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_titles
    ADD CONSTRAINT library_titles_pkey PRIMARY KEY (id);


--
-- Name: marks marks_exam_subject_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_exam_subject_id_student_id_key UNIQUE (exam_subject_id, student_id);


--
-- Name: marks marks_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_pkey PRIMARY KEY (id);


--
-- Name: message_log message_log_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_pkey PRIMARY KEY (id);


--
-- Name: message_templates message_templates_institution_id_code_channel_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_institution_id_code_channel_key UNIQUE (institution_id, code, channel);


--
-- Name: message_templates message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);


--
-- Name: module_settings module_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.module_settings
    ADD CONSTRAINT module_settings_pkey PRIMARY KEY (institution_id, module);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: numbering_schemes numbering_schemes_institution_id_campus_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_institution_id_campus_id_kind_key UNIQUE (institution_id, campus_id, kind);


--
-- Name: numbering_schemes numbering_schemes_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_pkey PRIMARY KEY (id);


--
-- Name: payment_allocations payment_allocations_payment_id_invoice_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_payment_id_invoice_id_key UNIQUE (payment_id, invoice_id);


--
-- Name: payment_allocations payment_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: periods periods_institution_id_campus_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_institution_id_campus_id_sequence_key UNIQUE (institution_id, campus_id, sequence);


--
-- Name: periods periods_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (key);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (code);


--
-- Name: refunds refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);


--
-- Name: report_cards report_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_pkey PRIMARY KEY (id);


--
-- Name: report_cards report_cards_student_id_academic_year_id_term_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_student_id_academic_year_id_term_id_key UNIQUE (student_id, academic_year_id, term_id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: route_stops route_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_pkey PRIMARY KEY (id);


--
-- Name: route_stops route_stops_route_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_route_id_sequence_key UNIQUE (route_id, sequence);


--
-- Name: routes routes_institution_id_campus_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_institution_id_campus_id_name_key UNIQUE (institution_id, campus_id, name);


--
-- Name: routes routes_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (id);


--
-- Name: section_subject_teachers section_subject_teachers_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_pkey PRIMARY KEY (id);


--
-- Name: section_subject_teachers section_subject_teachers_section_id_class_subject_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_section_id_class_subject_id_key UNIQUE (section_id, class_subject_id);


--
-- Name: sections sections_class_id_academic_year_id_name_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_class_id_academic_year_id_name_key UNIQUE (class_id, academic_year_id, name);


--
-- Name: sections sections_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: staff_attendance staff_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_pkey PRIMARY KEY (id);


--
-- Name: staff_attendance staff_attendance_user_id_on_date_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_user_id_on_date_key UNIQUE (user_id, on_date);


--
-- Name: student_achievements student_achievements_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_pkey PRIMARY KEY (id);


--
-- Name: student_attendance student_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_pkey PRIMARY KEY (id);


--
-- Name: student_documents student_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_pkey PRIMARY KEY (id);


--
-- Name: student_guardians student_guardians_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_pkey PRIMARY KEY (student_id, guardian_id);


--
-- Name: student_health student_health_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_health
    ADD CONSTRAINT student_health_pkey PRIMARY KEY (student_id);


--
-- Name: students students_institution_id_admission_no_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_institution_id_admission_no_key UNIQUE (institution_id, admission_no);


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);


--
-- Name: study_materials study_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_pkey PRIMARY KEY (id);


--
-- Name: subjects subjects_institution_id_campus_id_code_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_institution_id_campus_id_code_key UNIQUE (institution_id, campus_id, code);


--
-- Name: subjects subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (institution_id);


--
-- Name: substitutions substitutions_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_pkey PRIMARY KEY (id);


--
-- Name: substitutions substitutions_timetable_entry_id_on_date_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_timetable_entry_id_on_date_key UNIQUE (timetable_entry_id, on_date);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: terms terms_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.terms
    ADD CONSTRAINT terms_pkey PRIMARY KEY (id);


--
-- Name: timetable_entries timetable_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_pkey PRIMARY KEY (id);


--
-- Name: transport_allocations transport_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_pkey PRIMARY KEY (id);


--
-- Name: transport_allocations transport_allocations_student_id_academic_year_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_role_id_campus_id_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_id_campus_id_key UNIQUE (user_id, role_id, campus_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_institution_id_registration_no_key; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_institution_id_registration_no_key UNIQUE (institution_id, registration_no);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: academic_years_institution_id_campus_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX academic_years_institution_id_campus_id_idx ON public.academic_years USING btree (institution_id, campus_id);


--
-- Name: academic_years_one_current; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX academic_years_one_current ON public.academic_years USING btree (institution_id, COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_current;


--
-- Name: admission_assessments_application_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX admission_assessments_application_id_idx ON public.admission_assessments USING btree (application_id);


--
-- Name: admission_assessments_institution_id_scheduled_at_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX admission_assessments_institution_id_scheduled_at_idx ON public.admission_assessments USING btree (institution_id, scheduled_at);


--
-- Name: admission_sessions_institution_id_campus_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX admission_sessions_institution_id_campus_id_idx ON public.admission_sessions USING btree (institution_id, campus_id);


--
-- Name: announcement_acks_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX announcement_acks_institution_id_idx ON public.announcement_acks USING btree (institution_id);


--
-- Name: announcement_sections_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX announcement_sections_institution_id_idx ON public.announcement_sections USING btree (institution_id);


--
-- Name: announcements_institution_id_publish_at_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX announcements_institution_id_publish_at_idx ON public.announcements USING btree (institution_id, publish_at DESC);


--
-- Name: application_documents_application_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX application_documents_application_id_idx ON public.application_documents USING btree (application_id);


--
-- Name: application_documents_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX application_documents_institution_id_idx ON public.application_documents USING btree (institution_id);


--
-- Name: applications_campus_id_class_sought_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX applications_campus_id_class_sought_idx ON public.applications USING btree (campus_id, class_sought);


--
-- Name: applications_institution_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX applications_institution_id_status_idx ON public.applications USING btree (institution_id, status);


--
-- Name: applications_one_student; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX applications_one_student ON public.applications USING btree (student_id) WHERE (student_id IS NOT NULL);


--
-- Name: attendance_corrections_institution_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX attendance_corrections_institution_id_status_idx ON public.attendance_corrections USING btree (institution_id, status);


--
-- Name: audit_log_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX audit_log_entity_type_entity_id_idx ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: audit_log_institution_id_created_at_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX audit_log_institution_id_created_at_idx ON public.audit_log USING btree (institution_id, created_at DESC);


--
-- Name: campuses_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX campuses_institution_id_idx ON public.campuses USING btree (institution_id);


--
-- Name: class_subjects_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX class_subjects_institution_id_idx ON public.class_subjects USING btree (institution_id);


--
-- Name: classes_institution_id_campus_id_level_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX classes_institution_id_campus_id_level_idx ON public.classes USING btree (institution_id, campus_id, level);


--
-- Name: discipline_records_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX discipline_records_institution_id_idx ON public.discipline_records USING btree (institution_id);


--
-- Name: discipline_records_student_id_occurred_on_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX discipline_records_student_id_occurred_on_idx ON public.discipline_records USING btree (student_id, occurred_on DESC);


--
-- Name: employee_documents_employee_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX employee_documents_employee_id_idx ON public.employee_documents USING btree (employee_id);


--
-- Name: employee_documents_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX employee_documents_institution_id_idx ON public.employee_documents USING btree (institution_id);


--
-- Name: employees_institution_id_campus_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX employees_institution_id_campus_id_status_idx ON public.employees USING btree (institution_id, campus_id, status);


--
-- Name: employees_user_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX employees_user_id_idx ON public.employees USING btree (user_id);


--
-- Name: enquiries_institution_id_status_next_follow_up_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX enquiries_institution_id_status_next_follow_up_idx ON public.enquiries USING btree (institution_id, status, next_follow_up);


--
-- Name: enquiries_phone_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX enquiries_phone_idx ON public.enquiries USING btree (phone);


--
-- Name: enrollments_institution_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX enrollments_institution_id_academic_year_id_idx ON public.enrollments USING btree (institution_id, academic_year_id);


--
-- Name: enrollments_roll_no_unique; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX enrollments_roll_no_unique ON public.enrollments USING btree (section_id, roll_no) WHERE (roll_no IS NOT NULL);


--
-- Name: enrollments_section_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX enrollments_section_id_status_idx ON public.enrollments USING btree (section_id, status);


--
-- Name: exam_subjects_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX exam_subjects_institution_id_idx ON public.exam_subjects USING btree (institution_id);


--
-- Name: exams_institution_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX exams_institution_id_academic_year_id_idx ON public.exams USING btree (institution_id, academic_year_id);


--
-- Name: fee_concessions_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX fee_concessions_institution_id_idx ON public.fee_concessions USING btree (institution_id);


--
-- Name: fee_concessions_student_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX fee_concessions_student_id_academic_year_id_idx ON public.fee_concessions USING btree (student_id, academic_year_id);


--
-- Name: fee_structure_items_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX fee_structure_items_institution_id_idx ON public.fee_structure_items USING btree (institution_id);


--
-- Name: fee_structures_institution_id_academic_year_id_class_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX fee_structures_institution_id_academic_year_id_class_id_idx ON public.fee_structures USING btree (institution_id, academic_year_id, class_id);


--
-- Name: files_institution_id_owner_type_owner_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX files_institution_id_owner_type_owner_id_idx ON public.files USING btree (institution_id, owner_type, owner_id);


--
-- Name: grade_bands_grading_scale_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX grade_bands_grading_scale_id_idx ON public.grade_bands USING btree (grading_scale_id);


--
-- Name: grade_bands_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX grade_bands_institution_id_idx ON public.grade_bands USING btree (institution_id);


--
-- Name: guardians_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX guardians_institution_id_idx ON public.guardians USING btree (institution_id);


--
-- Name: guardians_user_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX guardians_user_id_idx ON public.guardians USING btree (user_id);


--
-- Name: guardians_user_lookup; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX guardians_user_lookup ON public.guardians USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: holidays_institution_id_on_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX holidays_institution_id_on_date_idx ON public.holidays USING btree (institution_id, on_date);


--
-- Name: homework_attachments_homework_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX homework_attachments_homework_id_idx ON public.homework_attachments USING btree (homework_id);


--
-- Name: homework_attachments_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX homework_attachments_institution_id_idx ON public.homework_attachments USING btree (institution_id);


--
-- Name: homework_institution_id_assigned_on_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX homework_institution_id_assigned_on_idx ON public.homework USING btree (institution_id, assigned_on);


--
-- Name: homework_section_id_due_on_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX homework_section_id_due_on_idx ON public.homework USING btree (section_id, due_on);


--
-- Name: homework_submissions_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX homework_submissions_institution_id_idx ON public.homework_submissions USING btree (institution_id);


--
-- Name: homework_submissions_student_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX homework_submissions_student_id_status_idx ON public.homework_submissions USING btree (student_id, status);


--
-- Name: invoice_lines_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX invoice_lines_institution_id_idx ON public.invoice_lines USING btree (institution_id);


--
-- Name: invoice_lines_invoice_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX invoice_lines_invoice_id_idx ON public.invoice_lines USING btree (invoice_id);


--
-- Name: invoices_institution_id_status_due_on_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX invoices_institution_id_status_due_on_idx ON public.invoices USING btree (institution_id, status, due_on);


--
-- Name: invoices_student_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX invoices_student_id_academic_year_id_idx ON public.invoices USING btree (student_id, academic_year_id);


--
-- Name: issued_certificates_institution_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX issued_certificates_institution_id_status_idx ON public.issued_certificates USING btree (institution_id, status);


--
-- Name: issued_certificates_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX issued_certificates_student_id_idx ON public.issued_certificates USING btree (student_id);


--
-- Name: leave_balances_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX leave_balances_institution_id_idx ON public.leave_balances USING btree (institution_id);


--
-- Name: leave_requests_employee_id_from_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX leave_requests_employee_id_from_date_idx ON public.leave_requests USING btree (employee_id, from_date);


--
-- Name: leave_requests_institution_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX leave_requests_institution_id_status_idx ON public.leave_requests USING btree (institution_id, status);


--
-- Name: leave_requests_student_id_from_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX leave_requests_student_id_from_date_idx ON public.leave_requests USING btree (student_id, from_date);


--
-- Name: library_copies_title_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX library_copies_title_id_status_idx ON public.library_copies USING btree (title_id, status);


--
-- Name: library_copy_active_loan; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX library_copy_active_loan ON public.library_loans USING btree (copy_id) WHERE (returned_on IS NULL);


--
-- Name: library_loans_institution_id_due_on_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX library_loans_institution_id_due_on_idx ON public.library_loans USING btree (institution_id, due_on) WHERE (returned_on IS NULL);


--
-- Name: library_loans_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX library_loans_student_id_idx ON public.library_loans USING btree (student_id);


--
-- Name: library_titles_institution_id_campus_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX library_titles_institution_id_campus_id_idx ON public.library_titles USING btree (institution_id, campus_id);


--
-- Name: library_titles_isbn_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX library_titles_isbn_idx ON public.library_titles USING btree (isbn);


--
-- Name: marks_institution_id_exam_subject_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX marks_institution_id_exam_subject_id_idx ON public.marks USING btree (institution_id, exam_subject_id);


--
-- Name: marks_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX marks_student_id_idx ON public.marks USING btree (student_id);


--
-- Name: message_log_institution_id_queued_at_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX message_log_institution_id_queued_at_idx ON public.message_log USING btree (institution_id, queued_at DESC);


--
-- Name: message_log_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX message_log_status_idx ON public.message_log USING btree (status) WHERE (status = ANY (ARRAY['queued'::text, 'failed'::text]));


--
-- Name: message_log_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX message_log_student_id_idx ON public.message_log USING btree (student_id);


--
-- Name: notifications_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX notifications_institution_id_idx ON public.notifications USING btree (institution_id);


--
-- Name: notifications_user_id_read_at_created_at_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX notifications_user_id_read_at_created_at_idx ON public.notifications USING btree (user_id, read_at, created_at DESC);


--
-- Name: payment_allocations_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX payment_allocations_institution_id_idx ON public.payment_allocations USING btree (institution_id);


--
-- Name: payment_allocations_invoice_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX payment_allocations_invoice_id_idx ON public.payment_allocations USING btree (invoice_id);


--
-- Name: payments_gateway_txn; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX payments_gateway_txn ON public.payments USING btree (gateway, gateway_txn_id) WHERE (gateway_txn_id IS NOT NULL);


--
-- Name: payments_institution_id_paid_on_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX payments_institution_id_paid_on_status_idx ON public.payments USING btree (institution_id, paid_on, status);


--
-- Name: payments_receipt_no; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX payments_receipt_no ON public.payments USING btree (institution_id, receipt_no) WHERE (receipt_no IS NOT NULL);


--
-- Name: payments_student_id_paid_on_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX payments_student_id_paid_on_idx ON public.payments USING btree (student_id, paid_on);


--
-- Name: refunds_institution_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX refunds_institution_id_status_idx ON public.refunds USING btree (institution_id, status);


--
-- Name: refunds_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX refunds_student_id_idx ON public.refunds USING btree (student_id);


--
-- Name: report_cards_institution_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX report_cards_institution_id_academic_year_id_idx ON public.report_cards USING btree (institution_id, academic_year_id);


--
-- Name: roles_institution_key; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX roles_institution_key ON public.roles USING btree (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), key);


--
-- Name: route_stops_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX route_stops_institution_id_idx ON public.route_stops USING btree (institution_id);


--
-- Name: section_subject_teachers_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX section_subject_teachers_institution_id_idx ON public.section_subject_teachers USING btree (institution_id);


--
-- Name: section_subject_teachers_teacher_user_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX section_subject_teachers_teacher_user_id_idx ON public.section_subject_teachers USING btree (teacher_user_id);


--
-- Name: sections_class_teacher_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX sections_class_teacher_id_idx ON public.sections USING btree (class_teacher_id);


--
-- Name: sections_institution_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX sections_institution_id_academic_year_id_idx ON public.sections USING btree (institution_id, academic_year_id);


--
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: staff_attendance_institution_id_on_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX staff_attendance_institution_id_on_date_idx ON public.staff_attendance USING btree (institution_id, on_date);


--
-- Name: student_achievements_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_achievements_institution_id_idx ON public.student_achievements USING btree (institution_id);


--
-- Name: student_achievements_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_achievements_student_id_idx ON public.student_achievements USING btree (student_id);


--
-- Name: student_attendance_daily; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX student_attendance_daily ON public.student_attendance USING btree (student_id, on_date) WHERE (period_id IS NULL);


--
-- Name: student_attendance_institution_id_on_date_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_attendance_institution_id_on_date_status_idx ON public.student_attendance USING btree (institution_id, on_date, status);


--
-- Name: student_attendance_period; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX student_attendance_period ON public.student_attendance USING btree (student_id, on_date, period_id) WHERE (period_id IS NOT NULL);


--
-- Name: student_attendance_section_id_on_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_attendance_section_id_on_date_idx ON public.student_attendance USING btree (section_id, on_date);


--
-- Name: student_documents_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_documents_institution_id_idx ON public.student_documents USING btree (institution_id);


--
-- Name: student_documents_student_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_documents_student_id_idx ON public.student_documents USING btree (student_id);


--
-- Name: student_guardians_guardian_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_guardians_guardian_id_idx ON public.student_guardians USING btree (guardian_id);


--
-- Name: student_guardians_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_guardians_institution_id_idx ON public.student_guardians USING btree (institution_id);


--
-- Name: student_guardians_one_primary; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX student_guardians_one_primary ON public.student_guardians USING btree (student_id) WHERE is_primary;


--
-- Name: student_health_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX student_health_institution_id_idx ON public.student_health USING btree (institution_id);


--
-- Name: students_institution_id_campus_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX students_institution_id_campus_id_status_idx ON public.students USING btree (institution_id, campus_id, status);


--
-- Name: students_institution_id_last_name_first_name_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX students_institution_id_last_name_first_name_idx ON public.students USING btree (institution_id, last_name, first_name);


--
-- Name: students_search; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX students_search ON public.students USING gin (to_tsvector('simple'::regconfig, ((((((COALESCE(first_name, ''::text) || ' '::text) || COALESCE(middle_name, ''::text)) || ' '::text) || COALESCE(last_name, ''::text)) || ' '::text) || admission_no)));


--
-- Name: students_user_id_unique; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX students_user_id_unique ON public.students USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: study_materials_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX study_materials_institution_id_idx ON public.study_materials USING btree (institution_id);


--
-- Name: study_materials_section_id_is_published_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX study_materials_section_id_is_published_idx ON public.study_materials USING btree (section_id, is_published);


--
-- Name: subscriptions_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX subscriptions_status_idx ON public.subscriptions USING btree (status);


--
-- Name: substitutions_institution_id_on_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX substitutions_institution_id_on_date_idx ON public.substitutions USING btree (institution_id, on_date);


--
-- Name: substitutions_substitute_user_id_on_date_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX substitutions_substitute_user_id_on_date_idx ON public.substitutions USING btree (substitute_user_id, on_date);


--
-- Name: support_tickets_institution_id_status_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX support_tickets_institution_id_status_idx ON public.support_tickets USING btree (institution_id, status);


--
-- Name: support_tickets_raised_by_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX support_tickets_raised_by_idx ON public.support_tickets USING btree (raised_by);


--
-- Name: terms_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX terms_academic_year_id_idx ON public.terms USING btree (academic_year_id);


--
-- Name: timetable_entries_institution_id_academic_year_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX timetable_entries_institution_id_academic_year_id_idx ON public.timetable_entries USING btree (institution_id, academic_year_id);


--
-- Name: timetable_section_slot; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX timetable_section_slot ON public.timetable_entries USING btree (section_id, weekday, period_id);


--
-- Name: timetable_teacher_slot; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX timetable_teacher_slot ON public.timetable_entries USING btree (teacher_user_id, weekday, period_id, academic_year_id) WHERE (teacher_user_id IS NOT NULL);


--
-- Name: transport_allocations_institution_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX transport_allocations_institution_id_idx ON public.transport_allocations USING btree (institution_id);


--
-- Name: transport_allocations_route_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX transport_allocations_route_id_idx ON public.transport_allocations USING btree (route_id);


--
-- Name: user_roles_user_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX user_roles_user_id_idx ON public.user_roles USING btree (user_id);


--
-- Name: users_institution_email; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX users_institution_email ON public.users USING btree (institution_id, email) WHERE (email IS NOT NULL);


--
-- Name: users_institution_phone; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX users_institution_phone ON public.users USING btree (institution_id, phone) WHERE (phone IS NOT NULL);


--
-- Name: users_platform_email; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE UNIQUE INDEX users_platform_email ON public.users USING btree (email) WHERE (institution_id IS NULL);


--
-- Name: vehicles_institution_id_campus_id_idx; Type: INDEX; Schema: public; Owner: erp_owner
--

CREATE INDEX vehicles_institution_id_campus_id_idx ON public.vehicles USING btree (institution_id, campus_id);


--
-- Name: applications applications_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER applications_touch BEFORE UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: campuses campuses_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER campuses_touch BEFORE UPDATE ON public.campuses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: employees employees_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER employees_touch BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: enquiries enquiries_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER enquiries_touch BEFORE UPDATE ON public.enquiries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: homework homework_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER homework_touch BEFORE UPDATE ON public.homework FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: institutions institutions_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER institutions_touch BEFORE UPDATE ON public.institutions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: invoices invoices_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER invoices_touch BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: payment_allocations payment_allocations_sync; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER payment_allocations_sync AFTER INSERT OR DELETE OR UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_paid();


--
-- Name: payment_allocations payment_allocations_sync_payment; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER payment_allocations_sync_payment AFTER INSERT OR DELETE OR UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION public.sync_payment_allocated();


--
-- Name: students students_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER students_touch BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: support_tickets support_tickets_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER support_tickets_touch BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: users users_touch; Type: TRIGGER; Schema: public; Owner: erp_owner
--

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: academic_years academic_years_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: academic_years academic_years_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: admission_assessments admission_assessments_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: admission_assessments admission_assessments_conducted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_conducted_by_fkey FOREIGN KEY (conducted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: admission_assessments admission_assessments_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_assessments
    ADD CONSTRAINT admission_assessments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: admission_sessions admission_sessions_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: admission_sessions admission_sessions_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: admission_sessions admission_sessions_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.admission_sessions
    ADD CONSTRAINT admission_sessions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: announcement_acks announcement_acks_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;


--
-- Name: announcement_acks announcement_acks_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: announcement_acks announcement_acks_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: announcement_acks announcement_acks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_acks
    ADD CONSTRAINT announcement_acks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: announcement_sections announcement_sections_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;


--
-- Name: announcement_sections announcement_sections_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: announcement_sections announcement_sections_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcement_sections
    ADD CONSTRAINT announcement_sections_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: announcements announcements_attachment_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_attachment_file_id_fkey FOREIGN KEY (attachment_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: announcements announcements_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: announcements announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: announcements announcements_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: application_documents application_documents_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: application_documents application_documents_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: application_documents application_documents_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: application_documents application_documents_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.application_documents
    ADD CONSTRAINT application_documents_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: applications applications_admission_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_admission_session_id_fkey FOREIGN KEY (admission_session_id) REFERENCES public.admission_sessions(id) ON DELETE SET NULL;


--
-- Name: applications applications_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: applications applications_class_sought_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_class_sought_fkey FOREIGN KEY (class_sought) REFERENCES public.classes(id) ON DELETE RESTRICT;


--
-- Name: applications applications_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: applications applications_enquiry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES public.enquiries(id) ON DELETE SET NULL;


--
-- Name: applications applications_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: applications applications_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;


--
-- Name: attendance_corrections attendance_corrections_attendance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES public.student_attendance(id) ON DELETE CASCADE;


--
-- Name: attendance_corrections attendance_corrections_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: attendance_corrections attendance_corrections_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: attendance_corrections attendance_corrections_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: campuses campuses_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: certificate_types certificate_types_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.certificate_types
    ADD CONSTRAINT certificate_types_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: class_subjects class_subjects_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;


--
-- Name: class_subjects class_subjects_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: class_subjects class_subjects_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;


--
-- Name: classes classes_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: classes classes_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: departments departments_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: departments departments_head_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_head_user_id_fkey FOREIGN KEY (head_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: departments departments_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: designations designations_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.designations
    ADD CONSTRAINT designations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: discipline_records discipline_records_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: discipline_records discipline_records_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: discipline_records discipline_records_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: employee_documents employee_documents_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_documents employee_documents_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: employee_documents employee_documents_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: employees employees_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: employees employees_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;


--
-- Name: employees employees_designation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES public.designations(id) ON DELETE SET NULL;


--
-- Name: employees employees_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: employees employees_photo_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_photo_file_id_fkey FOREIGN KEY (photo_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: employees employees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enquiries enquiries_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enquiries enquiries_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: enquiries enquiries_class_sought_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_class_sought_fkey FOREIGN KEY (class_sought) REFERENCES public.classes(id) ON DELETE SET NULL;


--
-- Name: enquiries enquiries_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: enrollments enrollments_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: enrollments enrollments_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE RESTRICT;


--
-- Name: enrollments enrollments_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: enrollments enrollments_promoted_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_promoted_from_id_fkey FOREIGN KEY (promoted_from_id) REFERENCES public.enrollments(id) ON DELETE SET NULL;


--
-- Name: enrollments enrollments_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE RESTRICT;


--
-- Name: enrollments enrollments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: exam_subjects exam_subjects_class_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;


--
-- Name: exam_subjects exam_subjects_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.exams(id) ON DELETE CASCADE;


--
-- Name: exam_subjects exam_subjects_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: exams exams_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: exams exams_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: exams exams_grading_scale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_grading_scale_id_fkey FOREIGN KEY (grading_scale_id) REFERENCES public.grading_scales(id) ON DELETE SET NULL;


--
-- Name: exams exams_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: exams exams_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: exams exams_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_term_id_fkey FOREIGN KEY (term_id) REFERENCES public.terms(id) ON DELETE SET NULL;


--
-- Name: fee_concessions fee_concessions_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: fee_concessions fee_concessions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fee_concessions fee_concessions_fee_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_fee_head_id_fkey FOREIGN KEY (fee_head_id) REFERENCES public.fee_heads(id) ON DELETE CASCADE;


--
-- Name: fee_concessions fee_concessions_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: fee_concessions fee_concessions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_concessions
    ADD CONSTRAINT fee_concessions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: fee_heads fee_heads_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: fee_heads fee_heads_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_heads
    ADD CONSTRAINT fee_heads_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: fee_structure_items fee_structure_items_fee_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_fee_head_id_fkey FOREIGN KEY (fee_head_id) REFERENCES public.fee_heads(id) ON DELETE RESTRICT;


--
-- Name: fee_structure_items fee_structure_items_fee_structure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_fee_structure_id_fkey FOREIGN KEY (fee_structure_id) REFERENCES public.fee_structures(id) ON DELETE CASCADE;


--
-- Name: fee_structure_items fee_structure_items_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structure_items
    ADD CONSTRAINT fee_structure_items_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: fee_structures fee_structures_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: fee_structures fee_structures_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: fee_structures fee_structures_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;


--
-- Name: fee_structures fee_structures_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: files files_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE SET NULL;


--
-- Name: files files_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: files files_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: grade_bands grade_bands_grading_scale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.grade_bands
    ADD CONSTRAINT grade_bands_grading_scale_id_fkey FOREIGN KEY (grading_scale_id) REFERENCES public.grading_scales(id) ON DELETE CASCADE;


--
-- Name: grade_bands grade_bands_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.grade_bands
    ADD CONSTRAINT grade_bands_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: grading_scales grading_scales_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: guardians guardians_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: guardians guardians_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: holidays holidays_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: holidays holidays_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: holidays holidays_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: homework_attachments homework_attachments_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: homework_attachments homework_attachments_homework_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_homework_id_fkey FOREIGN KEY (homework_id) REFERENCES public.homework(id) ON DELETE CASCADE;


--
-- Name: homework_attachments homework_attachments_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_attachments
    ADD CONSTRAINT homework_attachments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: homework homework_class_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE SET NULL;


--
-- Name: homework homework_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: homework homework_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: homework homework_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework
    ADD CONSTRAINT homework_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: homework_submissions homework_submissions_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: homework_submissions homework_submissions_graded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_graded_by_fkey FOREIGN KEY (graded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: homework_submissions homework_submissions_homework_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_homework_id_fkey FOREIGN KEY (homework_id) REFERENCES public.homework(id) ON DELETE CASCADE;


--
-- Name: homework_submissions homework_submissions_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: homework_submissions homework_submissions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.homework_submissions
    ADD CONSTRAINT homework_submissions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: houses houses_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: houses houses_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.houses
    ADD CONSTRAINT houses_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: integrations integrations_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: invoice_lines invoice_lines_fee_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_fee_head_id_fkey FOREIGN KEY (fee_head_id) REFERENCES public.fee_heads(id) ON DELETE RESTRICT;


--
-- Name: invoice_lines invoice_lines_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: invoice_lines invoice_lines_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: issued_certificates issued_certificates_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issued_certificates issued_certificates_certificate_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_certificate_type_id_fkey FOREIGN KEY (certificate_type_id) REFERENCES public.certificate_types(id) ON DELETE RESTRICT;


--
-- Name: issued_certificates issued_certificates_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: issued_certificates issued_certificates_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: issued_certificates issued_certificates_pdf_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_pdf_file_id_fkey FOREIGN KEY (pdf_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: issued_certificates issued_certificates_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issued_certificates issued_certificates_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON DELETE CASCADE;


--
-- Name: leave_requests leave_requests_applied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: leave_requests leave_requests_attachment_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_attachment_file_id_fkey FOREIGN KEY (attachment_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: leave_requests leave_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: leave_requests leave_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: leave_requests leave_requests_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: leave_requests leave_requests_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON DELETE SET NULL;


--
-- Name: leave_requests leave_requests_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: leave_types leave_types_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: library_copies library_copies_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: library_copies library_copies_title_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_copies
    ADD CONSTRAINT library_copies_title_id_fkey FOREIGN KEY (title_id) REFERENCES public.library_titles(id) ON DELETE CASCADE;


--
-- Name: library_loans library_loans_copy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_copy_id_fkey FOREIGN KEY (copy_id) REFERENCES public.library_copies(id) ON DELETE CASCADE;


--
-- Name: library_loans library_loans_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: library_loans library_loans_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: library_loans library_loans_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: library_loans library_loans_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_loans
    ADD CONSTRAINT library_loans_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: library_titles library_titles_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_titles
    ADD CONSTRAINT library_titles_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: library_titles library_titles_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.library_titles
    ADD CONSTRAINT library_titles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: marks marks_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: marks marks_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: marks marks_exam_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_exam_subject_id_fkey FOREIGN KEY (exam_subject_id) REFERENCES public.exam_subjects(id) ON DELETE CASCADE;


--
-- Name: marks marks_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: marks marks_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: message_log message_log_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: message_log message_log_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;


--
-- Name: message_log message_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_log
    ADD CONSTRAINT message_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: message_templates message_templates_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: module_settings module_settings_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.module_settings
    ADD CONSTRAINT module_settings_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: numbering_schemes numbering_schemes_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: numbering_schemes numbering_schemes_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.numbering_schemes
    ADD CONSTRAINT numbering_schemes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: payment_allocations payment_allocations_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: payment_allocations payment_allocations_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: payment_allocations payment_allocations_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payment_allocations
    ADD CONSTRAINT payment_allocations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE CASCADE;


--
-- Name: payments payments_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: payments payments_collected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_collected_by_fkey FOREIGN KEY (collected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: payments payments_reconciled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_reconciled_by_fkey FOREIGN KEY (reconciled_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: periods periods_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: periods periods_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: refunds refunds_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: refunds refunds_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: refunds refunds_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;


--
-- Name: refunds refunds_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: refunds refunds_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: report_cards report_cards_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: report_cards report_cards_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.enrollments(id) ON DELETE SET NULL;


--
-- Name: report_cards report_cards_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: report_cards report_cards_pdf_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_pdf_file_id_fkey FOREIGN KEY (pdf_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: report_cards report_cards_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: report_cards report_cards_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.report_cards
    ADD CONSTRAINT report_cards_term_id_fkey FOREIGN KEY (term_id) REFERENCES public.terms(id) ON DELETE SET NULL;


--
-- Name: role_permissions role_permissions_permission_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: roles roles_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: route_stops route_stops_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: route_stops route_stops_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.route_stops
    ADD CONSTRAINT route_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE CASCADE;


--
-- Name: routes routes_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: routes routes_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: routes routes_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;


--
-- Name: section_subject_teachers section_subject_teachers_class_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;


--
-- Name: section_subject_teachers section_subject_teachers_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: section_subject_teachers section_subject_teachers_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: section_subject_teachers section_subject_teachers_teacher_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.section_subject_teachers
    ADD CONSTRAINT section_subject_teachers_teacher_user_id_fkey FOREIGN KEY (teacher_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sections sections_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: sections sections_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: sections sections_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;


--
-- Name: sections sections_class_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_class_teacher_id_fkey FOREIGN KEY (class_teacher_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sections sections_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: staff_attendance staff_attendance_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: staff_attendance staff_attendance_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: staff_attendance staff_attendance_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: staff_attendance staff_attendance_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: student_achievements student_achievements_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE SET NULL;


--
-- Name: student_achievements student_achievements_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: student_achievements student_achievements_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: student_achievements student_achievements_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_achievements
    ADD CONSTRAINT student_achievements_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_attendance student_attendance_corrected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: student_attendance student_attendance_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: student_attendance student_attendance_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: student_attendance student_attendance_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.periods(id) ON DELETE CASCADE;


--
-- Name: student_attendance student_attendance_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: student_attendance student_attendance_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_documents student_documents_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: student_documents student_documents_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: student_documents student_documents_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_documents student_documents_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: student_guardians student_guardians_guardian_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES public.guardians(id) ON DELETE CASCADE;


--
-- Name: student_guardians student_guardians_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: student_guardians student_guardians_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_guardians
    ADD CONSTRAINT student_guardians_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_health student_health_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_health
    ADD CONSTRAINT student_health_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: student_health student_health_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.student_health
    ADD CONSTRAINT student_health_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: students students_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: students students_house_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_house_id_fkey FOREIGN KEY (house_id) REFERENCES public.houses(id) ON DELETE SET NULL;


--
-- Name: students students_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: students students_photo_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_photo_file_id_fkey FOREIGN KEY (photo_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: students students_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: study_materials study_materials_class_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;


--
-- Name: study_materials study_materials_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: study_materials study_materials_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: study_materials study_materials_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: study_materials study_materials_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: subjects subjects_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: subjects subjects_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_code_fkey FOREIGN KEY (plan_code) REFERENCES public.plans(code) ON DELETE RESTRICT;


--
-- Name: substitutions substitutions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: substitutions substitutions_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: substitutions substitutions_substitute_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_substitute_user_id_fkey FOREIGN KEY (substitute_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: substitutions substitutions_timetable_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.substitutions
    ADD CONSTRAINT substitutions_timetable_entry_id_fkey FOREIGN KEY (timetable_entry_id) REFERENCES public.timetable_entries(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;


--
-- Name: terms terms_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.terms
    ADD CONSTRAINT terms_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: terms terms_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.terms
    ADD CONSTRAINT terms_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_class_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_class_subject_id_fkey FOREIGN KEY (class_subject_id) REFERENCES public.class_subjects(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.periods(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_teacher_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_teacher_user_id_fkey FOREIGN KEY (teacher_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_allocations transport_allocations_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE CASCADE;


--
-- Name: transport_allocations transport_allocations_drop_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_drop_stop_id_fkey FOREIGN KEY (drop_stop_id) REFERENCES public.route_stops(id) ON DELETE SET NULL;


--
-- Name: transport_allocations transport_allocations_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: transport_allocations transport_allocations_pickup_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_pickup_stop_id_fkey FOREIGN KEY (pickup_stop_id) REFERENCES public.route_stops(id) ON DELETE SET NULL;


--
-- Name: transport_allocations transport_allocations_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE CASCADE;


--
-- Name: transport_allocations transport_allocations_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.transport_allocations
    ADD CONSTRAINT transport_allocations_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: vehicles vehicles_attendant_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_attendant_employee_id_fkey FOREIGN KEY (attendant_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: vehicles vehicles_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE CASCADE;


--
-- Name: vehicles vehicles_driver_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_driver_employee_id_fkey FOREIGN KEY (driver_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: vehicles vehicles_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: erp_owner
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: academic_years; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.academic_years ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_assessments; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.admission_assessments ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_sessions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.admission_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: announcement_acks; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.announcement_acks ENABLE ROW LEVEL SECURITY;

--
-- Name: announcement_sections; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.announcement_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: application_documents; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.application_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: applications; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance_corrections; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.attendance_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: campuses; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.campuses ENABLE ROW LEVEL SECURITY;

--
-- Name: certificate_types; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.certificate_types ENABLE ROW LEVEL SECURITY;

--
-- Name: class_subjects; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.class_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: classes; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

--
-- Name: departments; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

--
-- Name: designations; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.designations ENABLE ROW LEVEL SECURITY;

--
-- Name: discipline_records; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.discipline_records ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_documents; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: enquiries; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollments; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

--
-- Name: exam_subjects; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.exam_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: exams; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_concessions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.fee_concessions ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_heads; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.fee_heads ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_structure_items; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.fee_structure_items ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_structures; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.fee_structures ENABLE ROW LEVEL SECURITY;

--
-- Name: files; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

--
-- Name: grade_bands; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.grade_bands ENABLE ROW LEVEL SECURITY;

--
-- Name: grading_scales; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.grading_scales ENABLE ROW LEVEL SECURITY;

--
-- Name: guardians; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.guardians ENABLE ROW LEVEL SECURITY;

--
-- Name: holidays; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

--
-- Name: homework; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.homework ENABLE ROW LEVEL SECURITY;

--
-- Name: homework_attachments; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.homework_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: homework_submissions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.homework_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: houses; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.houses ENABLE ROW LEVEL SECURITY;

--
-- Name: institutions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;

--
-- Name: integrations; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_lines; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: issued_certificates; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.issued_certificates ENABLE ROW LEVEL SECURITY;

--
-- Name: leave_balances; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: leave_requests; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: leave_types; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;

--
-- Name: library_copies; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.library_copies ENABLE ROW LEVEL SECURITY;

--
-- Name: library_loans; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.library_loans ENABLE ROW LEVEL SECURITY;

--
-- Name: library_titles; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.library_titles ENABLE ROW LEVEL SECURITY;

--
-- Name: marks; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.marks ENABLE ROW LEVEL SECURITY;

--
-- Name: message_log; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.message_log ENABLE ROW LEVEL SECURITY;

--
-- Name: message_templates; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: module_settings; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.module_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: numbering_schemes; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.numbering_schemes ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_allocations; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: periods; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.periods ENABLE ROW LEVEL SECURITY;

--
-- Name: refunds; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: report_cards; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.report_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: route_stops; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY;

--
-- Name: routes; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;

--
-- Name: section_subject_teachers; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.section_subject_teachers ENABLE ROW LEVEL SECURITY;

--
-- Name: sections; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_attendance; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.staff_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: student_achievements; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.student_achievements ENABLE ROW LEVEL SECURITY;

--
-- Name: student_attendance; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.student_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: student_documents; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.student_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: student_guardians; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.student_guardians ENABLE ROW LEVEL SECURITY;

--
-- Name: student_health; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.student_health ENABLE ROW LEVEL SECURITY;

--
-- Name: students; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

--
-- Name: study_materials; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.study_materials ENABLE ROW LEVEL SECURITY;

--
-- Name: subjects; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: substitutions; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.substitutions ENABLE ROW LEVEL SECURITY;

--
-- Name: support_tickets; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: academic_years tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.academic_years USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: admission_assessments tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.admission_assessments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: admission_sessions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.admission_sessions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: announcement_acks tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.announcement_acks USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: announcement_sections tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.announcement_sections USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: announcements tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.announcements USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: application_documents tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.application_documents USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: applications tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.applications USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: attendance_corrections tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.attendance_corrections USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: audit_log tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.audit_log USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: campuses tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.campuses USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: certificate_types tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.certificate_types USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: class_subjects tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.class_subjects USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: classes tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.classes USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: departments tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.departments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: designations tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.designations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: discipline_records tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.discipline_records USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: employee_documents tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.employee_documents USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: employees tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.employees USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: enquiries tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.enquiries USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: enrollments tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.enrollments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: exam_subjects tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.exam_subjects USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: exams tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.exams USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: fee_concessions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.fee_concessions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: fee_heads tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.fee_heads USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: fee_structure_items tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.fee_structure_items USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: fee_structures tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.fee_structures USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: files tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.files USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: grade_bands tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.grade_bands USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: grading_scales tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.grading_scales USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: guardians tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.guardians USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: holidays tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.holidays USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: homework tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.homework USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: homework_attachments tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.homework_attachments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: homework_submissions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.homework_submissions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: houses tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.houses USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: institutions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.institutions USING ((public.app_is_platform_admin() OR (id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (id = public.app_current_institution())));


--
-- Name: integrations tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.integrations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: invoice_lines tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.invoice_lines USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: invoices tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.invoices USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: issued_certificates tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.issued_certificates USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: leave_balances tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.leave_balances USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: leave_requests tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.leave_requests USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: leave_types tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.leave_types USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: library_copies tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.library_copies USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: library_loans tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.library_loans USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: library_titles tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.library_titles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: marks tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.marks USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: message_log tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.message_log USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: message_templates tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.message_templates USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: module_settings tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.module_settings USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: notifications tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.notifications USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: numbering_schemes tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.numbering_schemes USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: payment_allocations tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.payment_allocations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: payments tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.payments USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: periods tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.periods USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: refunds tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.refunds USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: report_cards tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.report_cards USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: role_permissions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.role_permissions USING ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE (r.id = role_permissions.role_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND (public.app_is_platform_admin() OR (r.institution_id = public.app_current_institution()))))));


--
-- Name: roles tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.roles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()) OR (institution_id IS NULL))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: route_stops tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.route_stops USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: routes tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.routes USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: section_subject_teachers tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.section_subject_teachers USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: sections tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.sections USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: sessions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.sessions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: staff_attendance tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.staff_attendance USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: student_achievements tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.student_achievements USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: student_attendance tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.student_attendance USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: student_documents tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.student_documents USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: student_guardians tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.student_guardians USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: student_health tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.student_health USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: students tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.students USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: study_materials tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.study_materials USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: subjects tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.subjects USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: substitutions tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.substitutions USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: support_tickets tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.support_tickets USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: terms tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.terms USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: timetable_entries tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.timetable_entries USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: transport_allocations tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.transport_allocations USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: user_roles tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.user_roles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: users tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.users USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: vehicles tenant_isolation; Type: POLICY; Schema: public; Owner: erp_owner
--

CREATE POLICY tenant_isolation ON public.vehicles USING ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution()))) WITH CHECK ((public.app_is_platform_admin() OR (institution_id = public.app_current_institution())));


--
-- Name: terms; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.terms ENABLE ROW LEVEL SECURITY;

--
-- Name: timetable_entries; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.timetable_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_allocations; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.transport_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles; Type: ROW SECURITY; Schema: public; Owner: erp_owner
--

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO app_user;


--
-- Name: FUNCTION app_current_institution(); Type: ACL; Schema: public; Owner: erp_owner
--

GRANT ALL ON FUNCTION public.app_current_institution() TO app_user;


--
-- Name: FUNCTION app_is_platform_admin(); Type: ACL; Schema: public; Owner: erp_owner
--

GRANT ALL ON FUNCTION public.app_is_platform_admin() TO app_user;


--
-- Name: FUNCTION sync_invoice_paid(); Type: ACL; Schema: public; Owner: erp_owner
--

GRANT ALL ON FUNCTION public.sync_invoice_paid() TO app_user;


--
-- Name: FUNCTION sync_payment_allocated(); Type: ACL; Schema: public; Owner: erp_owner
--

GRANT ALL ON FUNCTION public.sync_payment_allocated() TO app_user;


--
-- Name: FUNCTION touch_updated_at(); Type: ACL; Schema: public; Owner: erp_owner
--

GRANT ALL ON FUNCTION public.touch_updated_at() TO app_user;


--
-- Name: TABLE academic_years; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.academic_years TO app_user;


--
-- Name: TABLE admission_assessments; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.admission_assessments TO app_user;


--
-- Name: TABLE admission_sessions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.admission_sessions TO app_user;


--
-- Name: TABLE announcement_acks; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.announcement_acks TO app_user;


--
-- Name: TABLE announcement_sections; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.announcement_sections TO app_user;


--
-- Name: TABLE announcements; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.announcements TO app_user;


--
-- Name: TABLE application_documents; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.application_documents TO app_user;


--
-- Name: TABLE applications; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.applications TO app_user;


--
-- Name: TABLE attendance_corrections; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_corrections TO app_user;


--
-- Name: TABLE audit_log; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_log TO app_user;


--
-- Name: SEQUENCE audit_log_id_seq; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,USAGE ON SEQUENCE public.audit_log_id_seq TO app_user;


--
-- Name: TABLE campuses; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.campuses TO app_user;


--
-- Name: TABLE certificate_types; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.certificate_types TO app_user;


--
-- Name: TABLE class_subjects; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.class_subjects TO app_user;


--
-- Name: TABLE classes; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.classes TO app_user;


--
-- Name: TABLE departments; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.departments TO app_user;


--
-- Name: TABLE designations; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.designations TO app_user;


--
-- Name: TABLE discipline_records; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.discipline_records TO app_user;


--
-- Name: TABLE employee_documents; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employee_documents TO app_user;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employees TO app_user;


--
-- Name: TABLE enquiries; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enquiries TO app_user;


--
-- Name: TABLE enrollments; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrollments TO app_user;


--
-- Name: TABLE exam_subjects; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.exam_subjects TO app_user;


--
-- Name: TABLE exams; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.exams TO app_user;


--
-- Name: TABLE fee_concessions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fee_concessions TO app_user;


--
-- Name: TABLE fee_heads; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fee_heads TO app_user;


--
-- Name: TABLE fee_structure_items; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fee_structure_items TO app_user;


--
-- Name: TABLE fee_structures; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fee_structures TO app_user;


--
-- Name: TABLE files; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.files TO app_user;


--
-- Name: TABLE goose_db_version; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.goose_db_version TO app_user;


--
-- Name: SEQUENCE goose_db_version_id_seq; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,USAGE ON SEQUENCE public.goose_db_version_id_seq TO app_user;


--
-- Name: TABLE grade_bands; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.grade_bands TO app_user;


--
-- Name: TABLE grading_scales; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.grading_scales TO app_user;


--
-- Name: TABLE guardians; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.guardians TO app_user;


--
-- Name: TABLE holidays; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.holidays TO app_user;


--
-- Name: TABLE homework; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.homework TO app_user;


--
-- Name: TABLE homework_attachments; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.homework_attachments TO app_user;


--
-- Name: TABLE homework_submissions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.homework_submissions TO app_user;


--
-- Name: TABLE houses; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.houses TO app_user;


--
-- Name: TABLE institutions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.institutions TO app_user;


--
-- Name: TABLE integrations; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.integrations TO app_user;


--
-- Name: TABLE invoice_lines; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invoice_lines TO app_user;


--
-- Name: TABLE invoices; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invoices TO app_user;


--
-- Name: TABLE issued_certificates; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.issued_certificates TO app_user;


--
-- Name: TABLE leave_balances; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.leave_balances TO app_user;


--
-- Name: TABLE leave_requests; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.leave_requests TO app_user;


--
-- Name: TABLE leave_types; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.leave_types TO app_user;


--
-- Name: TABLE library_copies; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.library_copies TO app_user;


--
-- Name: TABLE library_loans; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.library_loans TO app_user;


--
-- Name: TABLE library_titles; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.library_titles TO app_user;


--
-- Name: TABLE marks; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.marks TO app_user;


--
-- Name: TABLE message_log; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.message_log TO app_user;


--
-- Name: TABLE message_templates; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.message_templates TO app_user;


--
-- Name: TABLE module_settings; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.module_settings TO app_user;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO app_user;


--
-- Name: TABLE numbering_schemes; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.numbering_schemes TO app_user;


--
-- Name: TABLE payment_allocations; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payment_allocations TO app_user;


--
-- Name: TABLE payments; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payments TO app_user;


--
-- Name: TABLE periods; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.periods TO app_user;


--
-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.permissions TO app_user;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plans TO app_user;


--
-- Name: TABLE refunds; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.refunds TO app_user;


--
-- Name: TABLE report_cards; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.report_cards TO app_user;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.role_permissions TO app_user;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roles TO app_user;


--
-- Name: TABLE route_stops; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.route_stops TO app_user;


--
-- Name: TABLE routes; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routes TO app_user;


--
-- Name: TABLE section_subject_teachers; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.section_subject_teachers TO app_user;


--
-- Name: TABLE sections; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sections TO app_user;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO app_user;


--
-- Name: TABLE staff_attendance; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staff_attendance TO app_user;


--
-- Name: TABLE student_achievements; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.student_achievements TO app_user;


--
-- Name: TABLE student_attendance; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.student_attendance TO app_user;


--
-- Name: TABLE student_documents; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.student_documents TO app_user;


--
-- Name: TABLE student_guardians; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.student_guardians TO app_user;


--
-- Name: TABLE student_health; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.student_health TO app_user;


--
-- Name: TABLE students; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.students TO app_user;


--
-- Name: TABLE study_materials; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.study_materials TO app_user;


--
-- Name: TABLE subjects; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subjects TO app_user;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO app_user;


--
-- Name: TABLE substitutions; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.substitutions TO app_user;


--
-- Name: TABLE support_tickets; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_tickets TO app_user;


--
-- Name: TABLE terms; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.terms TO app_user;


--
-- Name: TABLE timetable_entries; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.timetable_entries TO app_user;


--
-- Name: TABLE transport_allocations; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.transport_allocations TO app_user;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_roles TO app_user;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO app_user;


--
-- Name: TABLE vehicles; Type: ACL; Schema: public; Owner: erp_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.vehicles TO app_user;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: erp_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO app_user;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: erp_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public GRANT ALL ON FUNCTIONS TO app_user;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: erp_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO app_user;


--
-- PostgreSQL database dump complete
--

\unrestrict QWqpEFhubueEEoXfu6Xgf4xgjmQXA6Ga9sfx41jqbphGSwpNitAXG4lOLcIhaoQ

