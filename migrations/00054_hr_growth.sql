-- Claimed as 00054. Renumbered from 00053, which W7's admin-ops migration took
-- at integration; may be renumbered again. Content is independent
-- of every other in-flight migration and touches no table it does not create.
--
-- Comments here are all `--` on purpose. goose's statement splitter counts
-- semicolons without understanding block comments, so a `;` inside a C-style
-- comment truncates the statement and the migration fails in a way that points
-- at the wrong line.

-- +goose Up

-- ===========================================================================
-- hr.hiring_growth.recruitment
--
-- A vacancy is raised and approved before anyone is interviewed, because the
-- expensive mistake in an Indian school is not a bad hire, it is a post nobody
-- authorised that payroll then has to carry for a year.
--
-- The pipeline shape is the one admissions already uses (enquiries ->
-- applications, a stage column, a decision): a candidate carries their current
-- stage and every transition is written to an event row. Deliberately its own
-- tables — a candidate is not a student, and the two funnels share nothing but
-- a shape.
-- ===========================================================================

CREATE TABLE job_vacancies (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id)   ON DELETE CASCADE,
    campus_id         uuid          REFERENCES campuses(id)       ON DELETE SET NULL,
    academic_year_id  uuid          REFERENCES academic_years(id) ON DELETE SET NULL,

    -- The school's own reference. Printed on the advertisement and quoted by
    -- every candidate who rings up, so it has to be theirs, not a uuid.
    code              text NOT NULL,
    title             text NOT NULL,
    department_id     uuid REFERENCES departments(id)  ON DELETE SET NULL,
    designation_id    uuid REFERENCES designations(id) ON DELETE SET NULL,
    -- "PGT Physics" is a designation and a subject, and a school with three
    -- open PGT posts needs to know which is which.
    subject_id        uuid REFERENCES subjects(id) ON DELETE SET NULL,
    employment_type   text,
    positions         integer NOT NULL DEFAULT 1,

    -- The advertised band, in paise per month. A band and not a figure: what
    -- is offered is settled candidate by candidate on job_offers.
    salary_min_paise  bigint,
    salary_max_paise  bigint,

    min_qualification     text,
    min_experience_years  numeric(4,1),
    -- Why the post is needed. This is what the approver reads.
    justification     text,

    status            text NOT NULL DEFAULT 'draft',
    raised_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    raised_on         date NOT NULL DEFAULT CURRENT_DATE,
    approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at       timestamptz,
    decision_note     text,
    closes_on         date,
    closed_at         timestamptz,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT job_vacancies_status CHECK (status IN
        ('draft','pending_approval','approved','on_hold','filled','closed','rejected')),
    CONSTRAINT job_vacancies_positions CHECK (positions > 0),
    CONSTRAINT job_vacancies_band CHECK (
        salary_min_paise IS NULL OR salary_max_paise IS NULL
        OR salary_max_paise >= salary_min_paise),
    CONSTRAINT job_vacancies_money_signed CHECK (
        COALESCE(salary_min_paise, 0) >= 0 AND COALESCE(salary_max_paise, 0) >= 0),
    -- The same vocabulary employees.employment_type already uses; a vacancy
    -- for a kind of post the employee table cannot hold is unfillable.
    CONSTRAINT job_vacancies_employment_type CHECK (
        employment_type IS NULL OR employment_type IN
        ('permanent','contract','probation','part_time','visiting')),
    -- Approved by nobody, or approved at no time, is an unapproved post that
    -- reads as approved on a list.
    CONSTRAINT job_vacancies_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
    CONSTRAINT job_vacancies_title CHECK (btrim(title) <> ''),
    CONSTRAINT job_vacancies_code  CHECK (btrim(code) <> '')
);

-- Both columns are NOT NULL, so this needs no COALESCE.
CREATE UNIQUE INDEX job_vacancies_one_per_code ON job_vacancies (institution_id, lower(code));
CREATE INDEX job_vacancies_by_status ON job_vacancies (institution_id, status);

COMMENT ON TABLE job_vacancies IS
    'A post the school has decided to fill. Raised, approved, advertised, and closed when somebody joins against it.';
COMMENT ON COLUMN job_vacancies.salary_min_paise IS
    'Advertised monthly band, in paise. What is actually offered is on job_offers.gross_monthly_paise.';

CREATE TABLE job_candidates (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vacancy_id       uuid NOT NULL REFERENCES job_vacancies(id) ON DELETE CASCADE,

    full_name        text NOT NULL,
    email            text,
    phone            text,
    gender           text,
    date_of_birth    date,
    qualification    text,
    experience_years numeric(4,1),
    current_employer text,
    expected_salary_paise bigint,
    notice_period_days    integer,

    source           text NOT NULL DEFAULT 'direct',
    referred_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    resume_file_id   uuid REFERENCES files(id) ON DELETE SET NULL,

    stage            text NOT NULL DEFAULT 'applied',
    stage_changed_at timestamptz NOT NULL DEFAULT now(),
    applied_on       date NOT NULL DEFAULT CURRENT_DATE,
    rating           numeric(3,1),
    notes            text,
    -- Why they stopped moving. Required reading before the same person is
    -- interviewed again next year.
    outcome_reason   text,

    -- The employee this candidate became.
    --
    -- Written once, by the hire step, which creates the employee through the
    -- same path the staff screen uses. The candidate row is never deleted and
    -- never rewritten into an employee: it is the evidence for the appointment
    -- and the only record of who else was considered.
    employee_id      uuid REFERENCES employees(id) ON DELETE SET NULL,
    hired_at         timestamptz,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT job_candidates_stage CHECK (stage IN
        ('applied','screened','shortlisted','interviewed','demo_lesson',
         'offered','joined','rejected','withdrawn')),
    CONSTRAINT job_candidates_source CHECK (source IN
        ('direct','walk_in','referral','portal','agency','newspaper','job_board','campus','other')),
    -- A candidate nobody can contact is a sheet of paper, not an application.
    CONSTRAINT job_candidates_reachable CHECK (
        COALESCE(btrim(email), '') <> '' OR COALESCE(btrim(phone), '') <> ''),
    CONSTRAINT job_candidates_name   CHECK (btrim(full_name) <> ''),
    CONSTRAINT job_candidates_gender CHECK (gender IS NULL OR gender IN ('male','female','other')),
    CONSTRAINT job_candidates_rating CHECK (rating IS NULL OR rating BETWEEN 0 AND 10),
    CONSTRAINT job_candidates_money  CHECK (
        expected_salary_paise IS NULL OR expected_salary_paise >= 0),
    CONSTRAINT job_candidates_notice CHECK (
        notice_period_days IS NULL OR notice_period_days BETWEEN 0 AND 365),
    -- "Joined" with no employee row is the failure mode this whole feature has
    -- to avoid: a hire that exists in recruitment and nowhere payroll can see.
    CONSTRAINT job_candidates_joined_has_employee CHECK (
        stage <> 'joined' OR employee_id IS NOT NULL),
    CONSTRAINT job_candidates_hired_pair CHECK ((employee_id IS NULL) = (hired_at IS NULL))
);

-- One person per vacancy, by whichever way of reaching them was recorded.
--
-- email and phone are each optional and either may be NULL, which is exactly
-- the case a bare UNIQUE silently fails to catch: NULL is distinct from every
-- other NULL, so two rows for the same candidate would both be accepted. The
-- CHECK above guarantees at least one is present, so the coalesced pair can
-- never be ('','') and collapse every anonymous row onto one key.
CREATE UNIQUE INDEX job_candidates_one_per_vacancy
    ON job_candidates (institution_id, vacancy_id,
                       lower(COALESCE(btrim(email), '')),
                       COALESCE(btrim(phone), ''));
CREATE INDEX job_candidates_by_stage ON job_candidates (institution_id, vacancy_id, stage);
CREATE INDEX job_candidates_by_employee ON job_candidates (employee_id) WHERE employee_id IS NOT NULL;

COMMENT ON COLUMN job_candidates.employee_id IS
    'Set by POST /hr-growth/candidates/{id}/hire, which creates the employee through the same insert the staff screen uses. Never cleared.';

-- Every transition, with who and when.
--
-- The candidate row carries only where they are now. "Who rejected her, and
-- on what day" is a question a school gets asked months later — sometimes by a
-- tribunal — and a status column cannot answer it.
CREATE TABLE job_candidate_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    candidate_id   uuid NOT NULL REFERENCES job_candidates(id) ON DELETE CASCADE,
    from_stage     text,
    to_stage       text NOT NULL,
    note           text,
    actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_candidate_events_by_candidate
    ON job_candidate_events (candidate_id, occurred_at DESC);

-- The demo lesson is the point of this table.
--
-- Indian schools do not hire a teacher on an interview; they watch them teach
-- a real section for a period and ask the class afterwards. That is a
-- scheduled event with a room, a panel and a subject, not a status.
CREATE TABLE job_interviews (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    candidate_id   uuid NOT NULL REFERENCES job_candidates(id) ON DELETE CASCADE,
    round          text NOT NULL,
    scheduled_at   timestamptz,
    mode           text NOT NULL DEFAULT 'in_person',
    -- Which class was taught, and what. Null for every round that is not a
    -- demo lesson.
    section_id     uuid REFERENCES sections(id) ON DELETE SET NULL,
    subject_id     uuid REFERENCES subjects(id) ON DELETE SET NULL,
    venue          text,
    -- Who sat on it. An array rather than a join table: a panel is read whole,
    -- never queried across, and three schools' worth of rows is not a scale
    -- problem.
    panel_user_ids uuid[] NOT NULL DEFAULT '{}',
    result         text NOT NULL DEFAULT 'scheduled',
    score          numeric(5,2),
    remarks        text,
    recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    recorded_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT job_interviews_round CHECK (round IN
        ('screening','written_test','subject_interview','demo_lesson','principal','management')),
    CONSTRAINT job_interviews_mode CHECK (mode IN ('in_person','video','phone')),
    CONSTRAINT job_interviews_result CHECK (result IN
        ('scheduled','pass','fail','hold','no_show','cancelled')),
    CONSTRAINT job_interviews_score CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    CONSTRAINT job_interviews_recorded_pair CHECK ((recorded_by IS NULL) = (recorded_at IS NULL))
);

CREATE INDEX job_interviews_by_candidate ON job_interviews (candidate_id, scheduled_at);
CREATE INDEX job_interviews_upcoming ON job_interviews (institution_id, scheduled_at)
    WHERE result = 'scheduled';

CREATE TABLE job_offers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    candidate_id   uuid NOT NULL REFERENCES job_candidates(id) ON DELETE CASCADE,
    offered_on     date NOT NULL DEFAULT CURRENT_DATE,
    designation_id uuid REFERENCES designations(id) ON DELETE SET NULL,
    department_id  uuid REFERENCES departments(id)  ON DELETE SET NULL,
    employment_type text,
    -- Paise per month. The figure the appointment letter carries.
    gross_monthly_paise bigint NOT NULL,
    joining_on     date,
    valid_until    date,
    status         text NOT NULL DEFAULT 'draft',
    responded_on   date,
    response_note  text,
    offer_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
    issued_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT job_offers_status CHECK (status IN
        ('draft','sent','accepted','declined','withdrawn','expired')),
    CONSTRAINT job_offers_money CHECK (gross_monthly_paise >= 0),
    CONSTRAINT job_offers_employment_type CHECK (
        employment_type IS NULL OR employment_type IN
        ('permanent','contract','probation','part_time','visiting')),
    CONSTRAINT job_offers_validity CHECK (valid_until IS NULL OR valid_until >= offered_on)
);

-- One live offer per candidate. Two open letters at different figures is how a
-- school ends up honouring the higher one.
CREATE UNIQUE INDEX job_offers_one_live ON job_offers (candidate_id)
    WHERE status IN ('draft','sent','accepted');
CREATE INDEX job_offers_by_institution ON job_offers (institution_id, status);

-- ===========================================================================
-- hr.hiring_growth.annual_performance_appraisal_kpi
--
-- This is the HR-owned annual KPI review: a cycle per academic year, a
-- weighted KPI set per role, a self-assessment, the reviewer's rating, a
-- moderation pass, and a final score with the discussion recorded.
--
-- It is deliberately NOT a 360. A 360 collects several people's view of one
-- person and is being built elsewhere; this instrument produces one number
-- that increments hang off. Everything here is named appraisal_* and nothing
-- is called evaluations, evaluation_cycles or feedback_requests, so the two
-- can coexist. Where a school wants the 360 result to count as one input,
-- appraisals.external_360_ref holds a pointer at evaluation_cycles(id) and
-- nothing more — this module never writes the 360 side.
--
-- The two instruments differ in a way that is structural, not stylistic. An
-- appraisal is attributable by design: appraisals.reviewer_user_id names who
-- gave the rating, because an increment nobody will put their name to is not
-- a judgement a school can defend. A 360 must not be, and evaluation_responses
-- carries no respondent column at all. That is why the only thing crossing the
-- boundary is a cycle id and a number somebody has already aggregated — never
-- a join that could re-attach a name to an anonymous answer.
-- ===========================================================================

CREATE TABLE appraisal_cycles (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
    name             text NOT NULL,
    status           text NOT NULL DEFAULT 'draft',
    opens_on         date,
    self_due_on      date,
    review_due_on    date,
    closes_on        date,
    -- Scores are recorded out of this. Five is the Indian norm; a school that
    -- runs out of ten changes one number rather than every screen.
    score_scale_max  numeric(5,2) NOT NULL DEFAULT 5,
    -- Whether a 360 result may be attached as one input. Off by default: this
    -- module cannot produce one and must not imply it can.
    allow_360_input  boolean NOT NULL DEFAULT false,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT appraisal_cycles_status CHECK (status IN
        ('draft','self_assessment','review','moderation','published','closed')),
    CONSTRAINT appraisal_cycles_scale CHECK (score_scale_max > 0),
    CONSTRAINT appraisal_cycles_name CHECK (btrim(name) <> ''),
    CONSTRAINT appraisal_cycles_window CHECK (
        opens_on IS NULL OR closes_on IS NULL OR closes_on >= opens_on)
);

-- academic_year_id is nullable, so it is coalesced. Without that, two cycles
-- both called "Annual 2026-27" with no year attached would both be accepted.
CREATE UNIQUE INDEX appraisal_cycles_one_per_name
    ON appraisal_cycles (institution_id,
                         COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         lower(name));

-- The weighted KPI set. A teacher's KPIs are not an accountant's.
--
-- designation_id NULL is the default set — what a role with no set of its own
-- is appraised against. A designation that has any rows of its own uses only
-- those; the two sets are never mixed, which is what keeps "weights total 100"
-- a question with one answer. appraisal_kpi_set() below is that rule.
CREATE TABLE appraisal_kpis (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    cycle_id       uuid NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
    designation_id uuid REFERENCES designations(id) ON DELETE CASCADE,
    code           text NOT NULL,
    title          text NOT NULL,
    description    text,
    -- Percent. The set must total exactly 100; see appraisal_weights_total.
    weight         numeric(5,2) NOT NULL,
    sequence       integer NOT NULL DEFAULT 0,
    -- Who supplies the number. 'self' is scored by the employee and confirmed
    -- by the reviewer; 'reviewer' is the reviewer's alone.
    source         text NOT NULL DEFAULT 'reviewer',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT appraisal_kpis_weight CHECK (weight > 0 AND weight <= 100),
    CONSTRAINT appraisal_kpis_source CHECK (source IN ('reviewer','self','attendance','results','360')),
    CONSTRAINT appraisal_kpis_code  CHECK (btrim(code) <> ''),
    CONSTRAINT appraisal_kpis_title CHECK (btrim(title) <> '')
);

CREATE UNIQUE INDEX appraisal_kpis_one_per_code
    ON appraisal_kpis (cycle_id,
                       COALESCE(designation_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       lower(code));
CREATE INDEX appraisal_kpis_by_cycle ON appraisal_kpis (institution_id, cycle_id);

CREATE TABLE appraisals (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    cycle_id          uuid NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
    employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- The role this appraisal was raised against, snapshotted. A promotion in
    -- February must not silently re-score January's KPIs against a new set.
    designation_id    uuid REFERENCES designations(id) ON DELETE SET NULL,
    reviewer_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    moderator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

    status            text NOT NULL DEFAULT 'not_started',

    self_submitted_at timestamptz,
    self_comments     text,
    self_score        numeric(6,2),

    reviewed_at       timestamptz,
    reviewer_comments text,
    reviewer_score    numeric(6,2),

    moderated_at      timestamptz,
    moderation_note   text,
    moderated_score   numeric(6,2),

    -- What the increment hangs off. Set at publication and not before.
    final_score       numeric(6,2),
    final_band        text,
    published_at      timestamptz,

    -- The conversation. An appraisal with a score and no discussion date is
    -- the one every teacher complains about.
    discussion_on     date,
    discussion_note   text,

    acknowledged_at   timestamptz,
    employee_comments text,

    increment_percent numeric(5,2),
    increment_paise   bigint,

    -- An optional pointer at a 360 result held by another module. Text plus a
    -- uuid rather than a foreign key, because this module must not depend on a
    -- table it does not own and must keep working if the 360 is never enabled.
    --
    -- The score is stored, not derived. Reading it live would mean a query
    -- from here into evaluation_answers, and a query that can count anonymous
    -- answers for one named employee is one refactor away from identifying
    -- them. What is copied is the aggregate the 360 module chose to publish.
    external_360_source text,
    external_360_ref    uuid,
    external_360_score  numeric(6,2),

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT appraisals_status CHECK (status IN
        ('not_started','self_submitted','reviewed','moderated','published','acknowledged')),
    CONSTRAINT appraisals_published_has_score CHECK (
        status NOT IN ('published','acknowledged') OR final_score IS NOT NULL),
    CONSTRAINT appraisals_published_pair CHECK (
        (status IN ('published','acknowledged')) = (published_at IS NOT NULL)),
    CONSTRAINT appraisals_increment CHECK (
        increment_percent IS NULL OR increment_percent BETWEEN -100 AND 200),
    CONSTRAINT appraisals_increment_money CHECK (
        increment_paise IS NULL OR increment_paise >= 0),
    -- A reviewer who is the person being appraised is not a review.
    CONSTRAINT appraisals_360_pair CHECK (
        (external_360_ref IS NULL) OR (external_360_source IS NOT NULL))
);

-- Both columns are NOT NULL, so no COALESCE is needed here.
CREATE UNIQUE INDEX appraisals_one_per_employee_per_cycle ON appraisals (cycle_id, employee_id);
CREATE INDEX appraisals_by_reviewer ON appraisals (institution_id, reviewer_user_id)
    WHERE reviewer_user_id IS NOT NULL;
CREATE INDEX appraisals_by_employee ON appraisals (institution_id, employee_id);

COMMENT ON COLUMN appraisals.external_360_ref IS
    'Optional evaluation_cycles(id) from the 360 module. Intentionally not a foreign key: this module must not depend on a table it does not own, and must work where the 360 is never enabled. Read-only from here — this module never writes the 360 side and never joins to evaluation_responses, whose anonymity is structural.';

CREATE TABLE appraisal_ratings (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    appraisal_id   uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
    kpi_id         uuid NOT NULL REFERENCES appraisal_kpis(id) ON DELETE CASCADE,
    -- The weight as it stood when this appraisal was raised.
    --
    -- Snapshotted rather than joined. Editing a KPI's weight in March must not
    -- silently restate a score somebody already signed in February, and this
    -- column is what makes that impossible rather than merely discouraged.
    weight         numeric(5,2) NOT NULL,
    self_score     numeric(6,2),
    self_note      text,
    reviewer_score numeric(6,2),
    reviewer_note  text,
    moderated_score numeric(6,2),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT appraisal_ratings_weight CHECK (weight > 0 AND weight <= 100),
    CONSTRAINT appraisal_ratings_self CHECK (self_score IS NULL OR self_score >= 0),
    CONSTRAINT appraisal_ratings_reviewer CHECK (reviewer_score IS NULL OR reviewer_score >= 0),
    CONSTRAINT appraisal_ratings_moderated CHECK (moderated_score IS NULL OR moderated_score >= 0)
);

CREATE UNIQUE INDEX appraisal_ratings_one_per_kpi ON appraisal_ratings (appraisal_id, kpi_id);

-- +goose StatementBegin
-- The KPI set that applies to one role in one cycle.
--
-- A designation with rows of its own uses those and only those; one without
-- falls back to the default set. Written as a function because three separate
-- places need the same answer and two of them are in the database.
CREATE FUNCTION appraisal_kpi_set(p_cycle uuid, p_designation uuid)
RETURNS SETOF appraisal_kpis
LANGUAGE sql STABLE
AS $$
    SELECT k.* FROM appraisal_kpis k
     WHERE k.cycle_id = p_cycle
       AND k.designation_id IS NOT DISTINCT FROM p_designation
    UNION ALL
    SELECT k.* FROM appraisal_kpis k
     WHERE k.cycle_id = p_cycle
       AND k.designation_id IS NULL
       AND p_designation IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM appraisal_kpis k2
                        WHERE k2.cycle_id = p_cycle
                          AND k2.designation_id = p_designation);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION appraisal_weights_total(p_cycle uuid, p_designation uuid)
RETURNS numeric
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(sum(weight), 0)::numeric FROM appraisal_kpi_set(p_cycle, p_designation);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- Weights total 100, enforced where it bites.
--
-- A cross-row sum cannot be a CHECK, and a trigger on appraisal_kpis would
-- refuse the first KPI anybody typed — the set is only ever briefly correct.
-- So the rule is applied at the moment it starts to matter: an appraisal
-- cannot be raised against a KPI set that does not total 100. Nothing can be
-- scored, moderated or published against a half-built set, and the same rule
-- holds for an import and a psql session as for the handler.
CREATE FUNCTION appraisal_weights_must_total_100() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    total numeric;
BEGIN
    total := appraisal_weights_total(NEW.cycle_id, NEW.designation_id);
    IF total <> 100 THEN
        RAISE EXCEPTION
            'the KPI weights for this role total %, not 100; fix the cycle before raising appraisals',
            total USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER appraisals_weights_total_100
    BEFORE INSERT ON appraisals
    FOR EACH ROW EXECUTE FUNCTION appraisal_weights_must_total_100();

-- ===========================================================================
-- hr.hiring_growth.staff_training_workshop_logs
--
-- What a teacher attended, when, run by whom, for how many hours, and the
-- certificate. The report that matters is not the list — it is hours completed
-- against the requirement, per teacher, per year, because 50 hours of annual
-- in-service training is what CBSE affiliation asks a school to evidence.
--
-- Certificates are files(id), the same shelf employee_documents already uses.
-- ===========================================================================

CREATE TABLE training_programmes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id        uuid REFERENCES campuses(id) ON DELETE SET NULL,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
    code             text NOT NULL,
    title            text NOT NULL,
    category         text,
    -- Who ran it. A named body, because "CBSE COE Hyderabad" is what an
    -- inspection asks for and "external" is not.
    provider         text,
    provider_kind    text NOT NULL DEFAULT 'internal',
    mode             text NOT NULL DEFAULT 'in_person',
    venue            text,
    starts_on        date NOT NULL,
    ends_on          date NOT NULL,
    -- Contact hours for the whole programme. A person may complete fewer;
    -- staff_training_records.hours_completed is what counts.
    hours            numeric(5,1) NOT NULL,
    is_mandatory     boolean NOT NULL DEFAULT false,
    -- Whether these hours count against the statutory requirement. A staff
    -- picnic with a session in it does not.
    counts_towards_requirement boolean NOT NULL DEFAULT true,
    cost_paise       bigint,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT training_programmes_dates CHECK (ends_on >= starts_on),
    CONSTRAINT training_programmes_hours CHECK (hours > 0 AND hours <= 2000),
    CONSTRAINT training_programmes_cost  CHECK (cost_paise IS NULL OR cost_paise >= 0),
    CONSTRAINT training_programmes_provider_kind CHECK (provider_kind IN
        ('internal','external','board','government','university','ngo','vendor')),
    CONSTRAINT training_programmes_mode CHECK (mode IN ('in_person','online','hybrid')),
    CONSTRAINT training_programmes_code  CHECK (btrim(code) <> ''),
    CONSTRAINT training_programmes_title CHECK (btrim(title) <> '')
);

CREATE UNIQUE INDEX training_programmes_one_per_code
    ON training_programmes (institution_id, lower(code));
CREATE INDEX training_programmes_when ON training_programmes (institution_id, starts_on);

CREATE TABLE staff_training_records (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    programme_id   uuid NOT NULL REFERENCES training_programmes(id) ON DELETE CASCADE,
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    status         text NOT NULL DEFAULT 'nominated',
    attended_on    date,
    -- Null until the programme is over. Defaulted from the programme by the
    -- handler on completion rather than by the column, because a teacher who
    -- left after the first morning completed three hours, not thirty.
    hours_completed numeric(5,1),
    score          numeric(5,2),
    certificate_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    certificate_no      text,
    certificate_issued_on date,
    feedback       text,
    nominated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staff_training_records_status CHECK (status IN
        ('nominated','attended','completed','absent','withdrawn')),
    CONSTRAINT staff_training_records_hours CHECK (
        hours_completed IS NULL OR hours_completed >= 0),
    -- Completed with no hours is a row that counts for nothing and looks like
    -- it counts for something.
    CONSTRAINT staff_training_records_completed_has_hours CHECK (
        status <> 'completed' OR hours_completed IS NOT NULL),
    CONSTRAINT staff_training_records_certificate CHECK (
        certificate_issued_on IS NULL OR status IN ('attended','completed'))
);

CREATE UNIQUE INDEX staff_training_records_one_per_person
    ON staff_training_records (programme_id, employee_id);
CREATE INDEX staff_training_records_by_employee
    ON staff_training_records (institution_id, employee_id);

-- How many hours a role owes in a year.
--
-- Kept as a row rather than a constant because the number is the board's, not
-- the software's: CBSE asks 50 for teaching staff, a state may ask another,
-- and a school may hold itself to more.
CREATE TABLE training_requirements (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- NULL means "every year until this is changed", which is how a statutory
    -- figure actually behaves.
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,
    -- Either a named designation or a whole category of them. Both NULL means
    -- everybody on the payroll.
    designation_id       uuid REFERENCES designations(id) ON DELETE CASCADE,
    designation_category text,
    required_hours   numeric(5,1) NOT NULL,
    authority        text,
    note             text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT training_requirements_hours CHECK (required_hours >= 0 AND required_hours <= 2000),
    CONSTRAINT training_requirements_category CHECK (
        designation_category IS NULL OR designation_category IN
        ('teaching','non_teaching','support','management'))
);

-- Three of the four key columns are nullable, so every one is coalesced. A
-- bare UNIQUE here would accept an unlimited number of "everybody, every year"
-- rows and the report would pick one of them arbitrarily.
CREATE UNIQUE INDEX training_requirements_one_per_role
    ON training_requirements (institution_id,
                              COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
                              COALESCE(designation_id,   '00000000-0000-0000-0000-000000000000'::uuid),
                              COALESCE(designation_category, ''));

-- ===========================================================================
-- hr.attendance.staff_shift_rostering
--
-- Non-teaching duty: the gate, the ground, exam invigilation, the transport
-- escort, the library and the labs. Teaching load is not here — it lives in
-- the timetable, and teacher_load_rules and teacher_unavailability (00050)
-- already govern it. This module reads those; it does not restate them.
--
-- Three checks make a roster usable, and they are enforced at three different
-- strengths on purpose:
--
--   double-booking      refused by the database. Two duties at one time is
--                       never a decision somebody meant to make.
--   approved leave      refused by the database. Rostering a person who is
--                       away is how a gate ends up unmanned at 07:00.
--   teaching that period  reported, not refused. Exam invigilation legitimately
--                       replaces the lesson it clashes with, and a hard gate
--                       here would block the commonest correct roster in the
--                       school year. The handler refuses it unless the caller
--                       says why, and records the reason.
-- ===========================================================================

CREATE TABLE duty_shifts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE CASCADE,
    code           text NOT NULL,
    name           text NOT NULL,
    duty_kind      text NOT NULL,
    starts_at      time NOT NULL,
    ends_at        time NOT NULL,
    -- ISO weekdays the pattern runs on: 1 is Monday, 7 is Sunday, matching
    -- timetable_entries.weekday and teacher_unavailability.weekday.
    weekdays       integer[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
    -- How many people the duty needs. The gate wants two at dispersal.
    headcount      integer NOT NULL DEFAULT 1,
    -- Nobody volunteers for the 07:00 gate or the Saturday ground. Marking the
    -- unpopular ones is what makes "is this spread fairly?" answerable rather
    -- than a matter of opinion in the staff room.
    is_onerous     boolean NOT NULL DEFAULT false,
    location       text,
    is_active      boolean NOT NULL DEFAULT true,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT duty_shifts_window CHECK (ends_at > starts_at),
    CONSTRAINT duty_shifts_headcount CHECK (headcount > 0 AND headcount <= 50),
    CONSTRAINT duty_shifts_kind CHECK (duty_kind IN
        ('gate','ground','exam_invigilation','transport_escort','library','lab',
         'reception','assembly','dispersal','hostel_night','canteen','other')),
    CONSTRAINT duty_shifts_weekdays CHECK (
        weekdays <@ ARRAY[1,2,3,4,5,6,7] AND array_length(weekdays, 1) > 0),
    CONSTRAINT duty_shifts_code CHECK (btrim(code) <> ''),
    CONSTRAINT duty_shifts_name CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX duty_shifts_one_per_code ON duty_shifts (institution_id, lower(code));
CREATE INDEX duty_shifts_live ON duty_shifts (institution_id, duty_kind) WHERE is_active;

-- One person, one duty, one day.
--
-- A range asked for by the screen is expanded into one row per date on write.
-- Storing a range instead would make "is this person free at 07:30 on Tuesday"
-- a query nothing can index and every conflict check a scan.
--
-- Keyed on user_id, not employee_id, because leave, the timetable and staff
-- attendance are all keyed on users.id and a duty that cannot be compared with
-- those three is a duty nothing can check. employee_id rides along for the HR
-- joins, and is set from the user by the handler.
CREATE TABLE duty_assignments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE SET NULL,
    shift_id       uuid NOT NULL REFERENCES duty_shifts(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_id    uuid REFERENCES employees(id) ON DELETE SET NULL,
    on_date        date NOT NULL,
    -- Copied from the shift and overridable: half the school's duties are the
    -- pattern, and the other half are the pattern with somebody covering the
    -- first twenty minutes.
    starts_at      time NOT NULL,
    ends_at        time NOT NULL,
    status         text NOT NULL DEFAULT 'scheduled',
    -- A clash with a teaching period, knowingly accepted. Null means there was
    -- nothing to accept.
    override_reason text,
    notes          text,
    assigned_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT duty_assignments_window CHECK (ends_at > starts_at),
    CONSTRAINT duty_assignments_status CHECK (status IN
        ('scheduled','completed','absent','swapped','cancelled'))
);

-- The same person on the same shift on the same day, twice. Every column is
-- NOT NULL so no COALESCE is needed; cancelled rows are excluded so a duty can
-- be withdrawn and re-issued.
CREATE UNIQUE INDEX duty_assignments_one_per_slot
    ON duty_assignments (user_id, on_date, shift_id) WHERE status <> 'cancelled';
CREATE INDEX duty_assignments_by_date ON duty_assignments (institution_id, on_date);
CREATE INDEX duty_assignments_by_person ON duty_assignments (institution_id, user_id, on_date);
CREATE INDEX duty_assignments_by_shift ON duty_assignments (shift_id, on_date);

-- +goose StatementBegin
-- The two checks that are absolute.
--
-- In the database rather than the handler because a roster arrives from the
-- rostering screen, a bulk range assignment and any import a school runs, and
-- a rule true of one of those is not a rule.
CREATE FUNCTION duty_assignment_is_free() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    emp uuid;
BEGIN
    IF NEW.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    -- Nobody rostered twice at the same time. Overlap, not equality: the 07:00
    -- gate and the 07:30 assembly are different shifts and still one person in
    -- two places.
    IF EXISTS (SELECT 1
                 FROM duty_assignments d
                WHERE d.user_id = NEW.user_id
                  AND d.on_date = NEW.on_date
                  AND d.id <> NEW.id
                  AND d.status <> 'cancelled'
                  AND d.starts_at < NEW.ends_at
                  AND d.ends_at   > NEW.starts_at) THEN
        RAISE EXCEPTION 'this person is already on duty at that time on %', NEW.on_date
            USING ERRCODE = 'check_violation';
    END IF;

    -- Nobody rostered while on approved leave. Resolved through employees
    -- rather than trusting the column, so a caller who omitted employee_id
    -- cannot skip the check by accident.
    emp := COALESCE(NEW.employee_id,
                    (SELECT e.id FROM employees e WHERE e.user_id = NEW.user_id LIMIT 1));
    IF emp IS NOT NULL AND EXISTS (
            SELECT 1 FROM leave_requests l
             WHERE l.employee_id  = emp
               AND l.subject_kind = 'staff'
               AND l.status       = 'approved'
               AND NEW.on_date BETWEEN l.from_date AND l.to_date) THEN
        RAISE EXCEPTION 'this person is on approved leave on %', NEW.on_date
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER duty_assignments_are_free
    BEFORE INSERT OR UPDATE ON duty_assignments
    FOR EACH ROW EXECUTE FUNCTION duty_assignment_is_free();

-- +goose StatementBegin
-- The third check, which reports rather than refuses.
--
-- Returns one row per assignment that lands on a period the person is
-- timetabled to teach, or on a slot they have declared unavailable. Both are
-- read from 00050's tables rather than restated here. The handler calls this
-- before writing and refuses without an override_reason; the roster screen
-- calls it over a whole range, because leave and the timetable both move after
-- a roster is published and a check that only ran on write goes stale.
CREATE FUNCTION duty_roster_conflicts(p_institution uuid, p_from date, p_to date)
RETURNS TABLE (
    assignment_id uuid,
    user_id       uuid,
    on_date       date,
    kind          text,
    detail        text
)
LANGUAGE sql STABLE
AS $$
    SELECT d.id, d.user_id, d.on_date, 'teaching'::text,
           'timetabled to teach ' || p.name || ' (' ||
           to_char(p.starts_at, 'HH24:MI') || '-' || to_char(p.ends_at, 'HH24:MI') || ')'
      FROM duty_assignments d
      JOIN timetable_entries te
        ON te.teacher_user_id = d.user_id
       AND te.weekday = EXTRACT(isodow FROM d.on_date)::int
      JOIN periods p
        ON p.id = te.period_id
       AND p.starts_at < d.ends_at
       AND p.ends_at   > d.starts_at
     WHERE d.institution_id = p_institution
       AND d.on_date BETWEEN p_from AND p_to
       AND d.status <> 'cancelled'

    UNION ALL

    SELECT d.id, d.user_id, d.on_date, 'unavailable'::text,
           COALESCE(tu.reason, 'declared unavailable')
      FROM duty_assignments d
      JOIN teacher_unavailability tu
        ON tu.teacher_user_id = d.user_id
       AND tu.institution_id  = d.institution_id
       AND tu.weekday = EXTRACT(isodow FROM d.on_date)::int
      LEFT JOIN periods p ON p.id = tu.period_id
     WHERE d.institution_id = p_institution
       AND d.on_date BETWEEN p_from AND p_to
       AND d.status <> 'cancelled'
       AND (tu.period_id IS NULL
            OR (p.starts_at < d.ends_at AND p.ends_at > d.starts_at))

    UNION ALL

    -- Leave approved after the roster was published. The trigger cannot catch
    -- this one: nothing wrote to duty_assignments when the leave was granted.
    SELECT d.id, d.user_id, d.on_date, 'leave'::text,
           'approved leave ' || to_char(l.from_date, 'DD Mon') ||
           ' to ' || to_char(l.to_date, 'DD Mon')
      FROM duty_assignments d
      JOIN employees e ON e.id = COALESCE(d.employee_id,
                                          (SELECT e2.id FROM employees e2
                                            WHERE e2.user_id = d.user_id LIMIT 1))
      JOIN leave_requests l
        ON l.employee_id  = e.id
       AND l.subject_kind = 'staff'
       AND l.status       = 'approved'
       AND d.on_date BETWEEN l.from_date AND l.to_date
     WHERE d.institution_id = p_institution
       AND d.on_date BETWEEN p_from AND p_to
       AND d.status <> 'cancelled';
$$;
-- +goose StatementEnd

COMMENT ON FUNCTION duty_roster_conflicts(uuid, date, date) IS
    'Every published duty that clashes with a teaching period, a declared unavailability or approved leave. Read by GET /hr-growth/roster/conflicts; recomputed rather than stored because the timetable and the leave queue both move after a roster is published.';

-- ------------------------------------------------------------------- touch

CREATE TRIGGER job_vacancies_touch BEFORE UPDATE ON job_vacancies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER job_candidates_touch BEFORE UPDATE ON job_candidates
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER job_interviews_touch BEFORE UPDATE ON job_interviews
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER job_offers_touch BEFORE UPDATE ON job_offers
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER appraisal_cycles_touch BEFORE UPDATE ON appraisal_cycles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER appraisal_kpis_touch BEFORE UPDATE ON appraisal_kpis
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER appraisals_touch BEFORE UPDATE ON appraisals
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER appraisal_ratings_touch BEFORE UPDATE ON appraisal_ratings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER training_programmes_touch BEFORE UPDATE ON training_programmes
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER staff_training_records_touch BEFORE UPDATE ON staff_training_records
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER training_requirements_touch BEFORE UPDATE ON training_requirements
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER duty_shifts_touch BEFORE UPDATE ON duty_shifts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER duty_assignments_touch BEFORE UPDATE ON duty_assignments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------- tenancy

ALTER TABLE job_vacancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_vacancies FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_candidates FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_candidate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_candidate_events FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_interviews FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_offers FORCE  ROW LEVEL SECURITY;
ALTER TABLE appraisal_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_cycles FORCE  ROW LEVEL SECURITY;
ALTER TABLE appraisal_kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_kpis FORCE  ROW LEVEL SECURITY;
ALTER TABLE appraisals ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisals FORCE  ROW LEVEL SECURITY;
ALTER TABLE appraisal_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_ratings FORCE  ROW LEVEL SECURITY;
ALTER TABLE training_programmes ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_programmes FORCE  ROW LEVEL SECURITY;
ALTER TABLE staff_training_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_training_records FORCE  ROW LEVEL SECURITY;
ALTER TABLE training_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_requirements FORCE  ROW LEVEL SECURITY;
ALTER TABLE duty_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE duty_shifts FORCE  ROW LEVEL SECURITY;
ALTER TABLE duty_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE duty_assignments FORCE  ROW LEVEL SECURITY;

CREATE POLICY job_vacancies_tenant ON job_vacancies
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY job_candidates_tenant ON job_candidates
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY job_candidate_events_tenant ON job_candidate_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY job_interviews_tenant ON job_interviews
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY job_offers_tenant ON job_offers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY appraisal_cycles_tenant ON appraisal_cycles
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY appraisal_kpis_tenant ON appraisal_kpis
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY appraisals_tenant ON appraisals
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY appraisal_ratings_tenant ON appraisal_ratings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY training_programmes_tenant ON training_programmes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_training_records_tenant ON staff_training_records
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY training_requirements_tenant ON training_requirements
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY duty_shifts_tenant ON duty_shifts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY duty_assignments_tenant ON duty_assignments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON
    job_vacancies, job_candidates, job_candidate_events, job_interviews, job_offers,
    appraisal_cycles, appraisal_kpis, appraisals, appraisal_ratings,
    training_programmes, staff_training_records, training_requirements,
    duty_shifts, duty_assignments
    TO app_user;

-- ------------------------------------------------------------------ seeds

-- +goose StatementBegin
-- Give every school the statutory training figure and a usable set of duty
-- shifts, so these screens answer a question on the day they ship rather than
-- after somebody finds a setup page.
--
-- institutions is itself under FORCE row-level security, so without the
-- set_config the loop sees no rows and seeds nothing at all — silently,
-- because iterating an empty result is not an error.
DO $$
DECLARE inst uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        -- CBSE's annual in-service expectation for teaching staff. A school
        -- that answers to another board edits the number; the row is the
        -- school's, not the software's.
        INSERT INTO training_requirements
            (institution_id, designation_category, required_hours, authority, note)
        VALUES (inst, 'teaching', 50, 'CBSE',
                'Annual in-service training hours expected of teaching staff.')
        ON CONFLICT DO NOTHING;

        INSERT INTO duty_shifts
            (institution_id, code, name, duty_kind, starts_at, ends_at, is_onerous, headcount)
        VALUES
            (inst, 'GATE_AM',   'Morning gate duty',   'gate',              TIME '07:15', TIME '08:15', true,  2),
            (inst, 'ASSEMBLY',  'Assembly duty',       'assembly',          TIME '08:15', TIME '08:45', false, 2),
            (inst, 'GROUND_PM', 'Ground and games',    'ground',            TIME '13:30', TIME '14:30', true,  2),
            (inst, 'DISPERSAL', 'Dispersal duty',      'dispersal',         TIME '15:00', TIME '15:45', true,  3),
            (inst, 'BUS_ESC',   'Transport escort',    'transport_escort',  TIME '15:15', TIME '16:30', true,  1),
            (inst, 'LIB_DESK',  'Library desk',        'library',           TIME '10:00', TIME '11:00', false, 1),
            (inst, 'LAB_DUTY',  'Laboratory duty',     'lab',               TIME '11:00', TIME '12:00', false, 1),
            (inst, 'INVIG',     'Exam invigilation',   'exam_invigilation', TIME '09:00', TIME '12:00', false, 1)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS duty_assignments_are_free ON duty_assignments;
DROP FUNCTION IF EXISTS duty_roster_conflicts(uuid, date, date);
DROP FUNCTION IF EXISTS duty_assignment_is_free();
DROP TABLE IF EXISTS duty_assignments;
DROP TABLE IF EXISTS duty_shifts;

DROP TABLE IF EXISTS training_requirements;
DROP TABLE IF EXISTS staff_training_records;
DROP TABLE IF EXISTS training_programmes;

DROP TRIGGER IF EXISTS appraisals_weights_total_100 ON appraisals;
DROP TABLE IF EXISTS appraisal_ratings;
DROP TABLE IF EXISTS appraisals;
DROP FUNCTION IF EXISTS appraisal_weights_must_total_100();
DROP FUNCTION IF EXISTS appraisal_weights_total(uuid, uuid);
DROP FUNCTION IF EXISTS appraisal_kpi_set(uuid, uuid);
DROP TABLE IF EXISTS appraisal_kpis;
DROP TABLE IF EXISTS appraisal_cycles;

DROP TABLE IF EXISTS job_offers;
DROP TABLE IF EXISTS job_interviews;
DROP TABLE IF EXISTS job_candidate_events;
DROP TABLE IF EXISTS job_candidates;
DROP TABLE IF EXISTS job_vacancies;
