-- +goose Up
-- The staff lifecycle: joining, serving, leaving.
--
-- The product held an employee row and a document shelf. Everything either
-- side of that — the KYC an appointment is conditional on, the service book an
-- inspector asks for by name, the clearances that must be signed before a
-- final settlement is paid, and the leave rules payroll silently assumes —
-- lived in a register on someone's desk.
--
-- Two shapes recur here and are deliberate. Anything that expires carries a
-- date rather than a boolean: "police verified" with no date proves nothing,
-- which is the decision 00021 already made for driver licences. And anything
-- that blocks is blocked in the database: a settlement paid while the library
-- is still owed three books is not an advisory failure.

-- ------------------------------------------------------------------ joining

/* The onboarding file, from offer to first morning.

   Kept apart from employees because these are facts about a process rather
   than about a person: an employee of eleven years has no onboarding status,
   and a school with two hundred staff should not carry eight columns that are
   null for a hundred and ninety of them.

   Every verification is a date and a reference, not a tick. A row saying PAN
   was verified, with nobody and no day attached, is exactly the record an
   audit treats as unverified. */
CREATE TABLE staff_onboarding (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    status          text        NOT NULL DEFAULT 'invited',
    offer_on        date,
    -- The day the appointee is expected; employees.joined_on is the day they
    -- actually reported. Schools plan against the first and pay against the
    -- second, and one column cannot be both.
    expected_on     date,
    form_submitted_on date,
    aadhaar_verified_on date,
    aadhaar_ref     text,
    pan_verified_on date,
    pan_ref         text,
    bank_verified_on date,
    -- Originals seen and returned. A school that photocopies degrees and never
    -- records who checked them against the original has verified nothing.
    originals_seen_on date,
    contract_file_id uuid       REFERENCES files(id) ON DELETE SET NULL,
    contract_signed_on date,
    joining_report_on date,
    verified_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_onboarding_status
        CHECK (status IN ('invited','submitted','verified','completed','abandoned')),
    -- Completing onboarding is the school saying the KYC is done. Allowing it
    -- with an unverified Aadhaar or PAN is how an unverifiable appointment
    -- reaches a payroll run.
    CONSTRAINT staff_onboarding_verified_means_verified
        CHECK (status NOT IN ('verified','completed')
               OR (aadhaar_verified_on IS NOT NULL AND pan_verified_on IS NOT NULL)),
    CONSTRAINT staff_onboarding_completed_has_contract
        CHECK (status <> 'completed' OR contract_signed_on IS NOT NULL),
    -- A reference number with no verification date is a number somebody typed.
    CONSTRAINT staff_onboarding_refs_dated
        CHECK ((aadhaar_ref IS NULL OR aadhaar_verified_on IS NOT NULL)
           AND (pan_ref     IS NULL OR pan_verified_on     IS NOT NULL))
);

-- One open file per employee. Re-onboarding a rejoiner is a new employee row,
-- not a second file against the old one.
CREATE UNIQUE INDEX staff_onboarding_one_per_employee
    ON staff_onboarding (employee_id);

-- ------------------------------------------------------------------ leaving

/* One exit, from notice to settlement.

   The exit interview, the departmental clearances, the relieving letter and
   the final settlement are four screens in most products and one event in
   every school. They share a row because they share a decision: whether this
   person may be relieved, and on what terms. */
CREATE TABLE staff_exits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind            text        NOT NULL DEFAULT 'resignation',
    notice_on       date        NOT NULL DEFAULT CURRENT_DATE,
    -- What the teacher asked for and what the school agreed. A mid-session
    -- resignation is routinely held to the end of term, and a single date
    -- would lose the negotiation the notice period exists to record.
    requested_last_day date,
    last_working_day date,
    reason          text,
    status          text        NOT NULL DEFAULT 'notice',

    -- The exit interview.
    interview_on    date,
    interviewed_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    primary_reason  text,
    would_rejoin    boolean,
    rating_management integer,
    rating_workload   integer,
    rating_facilities integer,
    feedback        text,

    -- The settlement. gross is what is owed, recovery is what the clearances
    -- said to take back; both are stored because the payslip has to show the
    -- deduction, not a net figure nobody can explain.
    settlement_status text      NOT NULL DEFAULT 'pending',
    settlement_paise bigint     NOT NULL DEFAULT 0,
    recovery_paise  bigint      NOT NULL DEFAULT 0,
    settled_on      date,
    relieved_on     date,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_exits_kind
        CHECK (kind IN ('resignation','termination','retirement','contract_end','transfer_out','death')),
    CONSTRAINT staff_exits_status
        CHECK (status IN ('notice','interviewed','cleared','relieved','settled','withdrawn')),
    CONSTRAINT staff_exits_settlement_status
        CHECK (settlement_status IN ('pending','authorised','paid','withheld')),
    CONSTRAINT staff_exits_ratings
        CHECK (COALESCE(rating_management, 3) BETWEEN 1 AND 5
           AND COALESCE(rating_workload,   3) BETWEEN 1 AND 5
           AND COALESCE(rating_facilities, 3) BETWEEN 1 AND 5),
    CONSTRAINT staff_exits_interview_dated
        CHECK ((primary_reason IS NULL AND would_rejoin IS NULL) OR interview_on IS NOT NULL),
    -- A termination with no reason on file is the one an appellate tribunal
    -- asks about first.
    CONSTRAINT staff_exits_termination_has_reason
        CHECK (kind <> 'termination' OR nullif(btrim(reason), '') IS NOT NULL),
    CONSTRAINT staff_exits_relieved_is_dated
        CHECK (status NOT IN ('relieved','settled') OR relieved_on IS NOT NULL),
    CONSTRAINT staff_exits_amounts
        CHECK (settlement_paise >= 0 AND recovery_paise >= 0),
    CONSTRAINT staff_exits_last_day_after_notice
        CHECK (last_working_day IS NULL OR last_working_day >= notice_on)
);

-- One open exit per employee. A withdrawn resignation must not stop the next
-- one being recorded, so only live rows take the lock.
CREATE UNIQUE INDEX staff_exits_one_open_per_employee
    ON staff_exits (employee_id) WHERE status <> 'withdrawn';

CREATE INDEX staff_exits_pending
    ON staff_exits (institution_id, notice_on DESC) WHERE status <> 'settled';

/* The departments that have to sign before anybody is relieved.

   A list rather than fixed columns, because it is the one part of this that
   genuinely differs between schools: a day school has no hostel, and a school
   with three science blocks signs three times. Deactivating a department stops
   it appearing on new exits without rewriting the ones already open. */
CREATE TABLE clearance_departments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    code            text        NOT NULL,
    name            text        NOT NULL,
    sequence        integer     NOT NULL DEFAULT 100,
    is_active       boolean     NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX clearance_departments_code
    ON clearance_departments (institution_id, code);

/* One department's answer on one exit.

   dues_paise is the whole point of the feature. "No-deduction clearance" does
   not mean the library waves the teacher through; it means the library states
   what is outstanding so the settlement can deduct it, and states it before
   the money moves rather than a month afterwards. */
CREATE TABLE exit_clearances (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    exit_id         uuid        NOT NULL REFERENCES staff_exits(id) ON DELETE CASCADE,
    department_id   uuid        NOT NULL REFERENCES clearance_departments(id) ON DELETE RESTRICT,
    status          text        NOT NULL DEFAULT 'pending',
    dues_paise      bigint      NOT NULL DEFAULT 0,
    remarks         text,
    cleared_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    cleared_on      date,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT exit_clearances_status CHECK (status IN ('pending','dues','cleared')),
    CONSTRAINT exit_clearances_dues_amount CHECK (dues_paise >= 0),
    CONSTRAINT exit_clearances_cleared_is_dated
        CHECK (status <> 'cleared' OR cleared_on IS NOT NULL),
    -- Money taken out of a final settlement has to have a sentence next to it;
    -- a bare figure is the deduction the teacher disputes and nobody can
    -- justify eighteen months later.
    CONSTRAINT exit_clearances_deduction_explained
        CHECK (dues_paise = 0 OR nullif(btrim(remarks), '') IS NOT NULL),
    CONSTRAINT exit_clearances_hold_has_reason
        CHECK (status <> 'dues' OR nullif(btrim(remarks), '') IS NOT NULL)
);

CREATE UNIQUE INDEX exit_clearances_one_per_department
    ON exit_clearances (exit_id, department_id);

CREATE INDEX exit_clearances_outstanding
    ON exit_clearances (institution_id) WHERE status <> 'cleared';

-- +goose StatementBegin
/* Settlement is blocked in the database, not in a handler.

   The clearance checklist only means something if the money cannot move past
   it. Enforcing this in Go would leave the rule true of one code path and
   false of every import, fixture and psql session. The empty-list case is
   refused too: an exit with no clearances raised is not a cleared exit, it is
   an unasked question. */
CREATE FUNCTION hr_settlement_needs_clearance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    raised      integer;
    outstanding integer;
BEGIN
    IF NEW.settlement_status <> 'paid' OR OLD.settlement_status = 'paid' THEN
        RETURN NEW;
    END IF;
    SELECT count(*), count(*) FILTER (WHERE status <> 'cleared')
      INTO raised, outstanding
      FROM exit_clearances WHERE exit_id = NEW.id;
    IF raised = 0 THEN
        RAISE EXCEPTION 'settlement blocked: no departmental clearance was raised for this exit'
            USING ERRCODE = 'check_violation';
    END IF;
    IF outstanding > 0 THEN
        RAISE EXCEPTION 'settlement blocked: % departmental clearance(s) still outstanding', outstanding
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER staff_exits_clearance_gate
    BEFORE UPDATE ON staff_exits
    FOR EACH ROW EXECUTE FUNCTION hr_settlement_needs_clearance();

CREATE TRIGGER staff_exits_touch BEFORE UPDATE ON staff_exits
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER staff_onboarding_touch BEFORE UPDATE ON staff_onboarding
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER exit_clearances_touch BEFORE UPDATE ON exit_clearances
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- --------------------------------------------------------------- the posting

/* Transfers, deputations and the postings between them.

   The other school is text rather than a foreign key: a teacher deputed to a
   government school under a district order is going somewhere this product
   has never heard of, and modelling only intra-tenant moves would make the
   feature useless for exactly the transfers the state runs. */
CREATE TABLE staff_transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind            text        NOT NULL DEFAULT 'transfer',
    from_campus_id  uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    to_campus_id    uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    to_institution  text,
    order_no        text,
    order_date      date,
    effective_from  date        NOT NULL,
    -- When the teacher comes back. Null means never, which is what makes this
    -- a transfer; a deputation with no end date is a transfer nobody admitted
    -- to, and the seniority list is the thing that goes wrong.
    effective_to    date,
    relieved_on     date,
    reported_on     date,
    reason          text,
    remarks         text,
    status          text        NOT NULL DEFAULT 'ordered',
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_transfers_kind
        CHECK (kind IN ('transfer','deputation','promotion','posting','repatriation')),
    CONSTRAINT staff_transfers_status
        CHECK (status IN ('ordered','relieved','reported','returned','cancelled')),
    CONSTRAINT staff_transfers_deputation_ends
        CHECK (kind <> 'deputation' OR effective_to IS NOT NULL),
    CONSTRAINT staff_transfers_period
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
    -- Somewhere to go. Without one this is a note, not a posting order.
    CONSTRAINT staff_transfers_has_destination
        CHECK (to_campus_id IS NOT NULL OR nullif(btrim(to_institution), '') IS NOT NULL
               OR kind IN ('promotion','repatriation')),
    CONSTRAINT staff_transfers_reported_after_relieved
        CHECK (relieved_on IS NULL OR reported_on IS NULL OR reported_on >= relieved_on)
);

CREATE INDEX staff_transfers_employee
    ON staff_transfers (employee_id, effective_from DESC);

/* The service book, digitised.

   A page per event, in the order the events happened: appointment,
   confirmation, every increment, every transfer, every punishment and every
   award. This is the record a DEO inspection asks for by name and the one a
   pension claim is settled from thirty years later, which is why an attested
   entry can never be edited — see the trigger below. */
CREATE TABLE service_book_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    entry_kind      text        NOT NULL,
    event_date      date        NOT NULL,
    title           text        NOT NULL,
    particulars     text,
    order_no        text,
    order_date      date,
    designation_id  uuid        REFERENCES designations(id) ON DELETE SET NULL,
    department_id   uuid        REFERENCES departments(id) ON DELETE SET NULL,
    pay_paise       bigint,
    file_id         uuid        REFERENCES files(id) ON DELETE SET NULL,
    -- Attestation is the signature of the officer who checked the entry
    -- against the order. Until it exists the page is a claim.
    attested_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    attested_on     date,
    -- Which flow wrote the page. Entries raised by an exit or a transfer are
    -- marked so a clerk can see what the system asserted and what a person did.
    source          text        NOT NULL DEFAULT 'manual',
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT service_book_entries_kind
        CHECK (entry_kind IN ('appointment','confirmation','promotion','increment',
                              'transfer','deputation','leave_without_pay','suspension',
                              'punishment','award','training','qualification',
                              'relieving','retirement','other')),
    CONSTRAINT service_book_entries_source
        CHECK (source IN ('manual','onboarding','transfer','exit','payroll')),
    CONSTRAINT service_book_entries_attested_is_signed
        CHECK ((attested_by IS NULL) = (attested_on IS NULL)),
    -- Pay is what the order says, in paise. Zero is a real answer for a
    -- punishment; a negative one is a typing mistake.
    CONSTRAINT service_book_entries_pay CHECK (pay_paise IS NULL OR pay_paise >= 0)
);

CREATE INDEX service_book_entries_employee
    ON service_book_entries (employee_id, event_date, created_at);

-- +goose StatementBegin
/* An attested page is final.

   A service book that can be rewritten is not a service book. Corrections go
   in as a further entry citing the order that made them, which is how the
   paper volume has always worked and the only version a pension office will
   accept. Unattested drafts stay editable so a clerk can finish typing. */
CREATE FUNCTION service_book_attested_is_final() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    /* A school being closed down must not be held up by a page in a book. The
       employee row is already gone by the time a cascade reaches here, which
       is what distinguishes it from a clerk deleting one entry. */
    IF TG_OP = 'DELETE'
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = OLD.employee_id) THEN
        RETURN OLD;
    END IF;
    IF OLD.attested_on IS NOT NULL THEN
        RAISE EXCEPTION 'service book entry attested on % cannot be altered; record a correcting entry instead',
            OLD.attested_on USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
-- +goose StatementEnd

CREATE TRIGGER service_book_entries_immutable
    BEFORE UPDATE OR DELETE ON service_book_entries
    FOR EACH ROW EXECUTE FUNCTION service_book_attested_is_final();

-- ------------------------------------------------------------- verification

/* Degrees, diplomas and the teaching qualifications a board inspects.

   employees.qualification already holds a one-line summary for a directory
   card. It cannot hold four degrees, their universities, their years and
   which of them a TET certificate is attached to, which is what an inspection
   asks for — so this extends that column rather than replacing it. */
CREATE TABLE staff_qualifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    qualification   text        NOT NULL,
    level           text        NOT NULL DEFAULT 'graduate',
    discipline      text,
    board_university text,
    year_of_passing integer,
    percentage      numeric(5,2),
    registration_no text,
    -- B.Ed, D.El.Ed, TET and CTET are what make a teacher eligible to teach a
    -- stage. Flagged rather than inferred from the name, because schools spell
    -- them six ways and an inspection counts the flagged ones.
    is_teaching_qualification boolean NOT NULL DEFAULT false,
    -- CTET was valid for seven years until 2021 and for life afterwards, and
    -- some state TETs still expire. Null means it does not.
    valid_until     date,
    certificate_file_id uuid    REFERENCES files(id) ON DELETE SET NULL,
    verified_on     date,
    verified_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    verification_ref text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_qualifications_level
        CHECK (level IN ('school','diploma','graduate','post_graduate','doctorate',
                         'professional','certification')),
    CONSTRAINT staff_qualifications_year
        CHECK (year_of_passing IS NULL OR year_of_passing BETWEEN 1930 AND 2100),
    CONSTRAINT staff_qualifications_percentage
        CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
    CONSTRAINT staff_qualifications_verified_is_dated
        CHECK (verification_ref IS NULL OR verified_on IS NOT NULL),
    CONSTRAINT staff_qualifications_attested
        CHECK ((verified_by IS NULL) OR verified_on IS NOT NULL)
);

-- The same degree from the same university in the same year, twice, is a
-- double entry rather than a second qualification. discipline and year are
-- optional, and a null inside a unique index silently switches it off, so
-- both are coalesced into the key.
CREATE UNIQUE INDEX staff_qualifications_no_duplicates
    ON staff_qualifications (employee_id, lower(qualification),
                             lower(COALESCE(discipline, '')),
                             COALESCE(year_of_passing, 0));

/* Medical fitness, with an expiry that is not optional.

   Food handlers, drivers and nannies are certified annually because the
   certificate is a statement about today. A registry row with no expiry is
   the gap that hides itself: it reads as compliant for ever and nobody is
   ever told to book the next examination. 00021 made the same call for driver
   licences and this is the same failure. */
CREATE TABLE medical_fitness_certificates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    purpose         text        NOT NULL DEFAULT 'general',
    issued_on       date        NOT NULL,
    valid_until     date        NOT NULL,
    fit             boolean     NOT NULL DEFAULT true,
    examined_by     text,
    clinic          text,
    restrictions    text,
    certificate_file_id uuid    REFERENCES files(id) ON DELETE SET NULL,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT medical_fitness_purpose
        CHECK (purpose IN ('general','food_handler','driver','nanny','hostel','lab','sports')),
    CONSTRAINT medical_fitness_period CHECK (valid_until > issued_on),
    -- "Not fit" with nothing written next to it cannot be acted on: the school
    -- learns nothing about whether the person may still teach.
    CONSTRAINT medical_fitness_unfit_is_explained
        CHECK (fit OR nullif(btrim(restrictions), '') IS NOT NULL)
);

CREATE UNIQUE INDEX medical_fitness_one_per_examination
    ON medical_fitness_certificates (employee_id, purpose, issued_on);

CREATE INDEX medical_fitness_expiring
    ON medical_fitness_certificates (institution_id, valid_until);

/* Police and background verification.

   Mandatory for anyone working with children and, under the POCSO guidance
   most states issue, repeated rather than done once. valid_until is therefore
   required as soon as a check completes: a verification with a completion
   date and no re-check date reads as permanently clear, which is precisely
   the record that lets a lapsed check sit unnoticed for nine years. */
CREATE TABLE background_verifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind            text        NOT NULL DEFAULT 'police',
    agency          text,
    requested_on    date        NOT NULL DEFAULT CURRENT_DATE,
    reference_no    text,
    status          text        NOT NULL DEFAULT 'requested',
    completed_on    date,
    valid_until     date,
    findings        text,
    certificate_file_id uuid    REFERENCES files(id) ON DELETE SET NULL,
    recorded_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT background_verifications_kind
        CHECK (kind IN ('police','court','address','education','previous_employer','reference')),
    CONSTRAINT background_verifications_status
        CHECK (status IN ('requested','in_progress','clear','adverse','withdrawn')),
    CONSTRAINT background_verifications_finished_is_dated
        CHECK (status NOT IN ('clear','adverse') OR completed_on IS NOT NULL),
    CONSTRAINT background_verifications_clear_expires
        CHECK (status <> 'clear' OR valid_until IS NOT NULL),
    -- An adverse report with no findings recorded is a decision the school
    -- cannot defend and the employee cannot answer.
    CONSTRAINT background_verifications_adverse_is_explained
        CHECK (status <> 'adverse' OR nullif(btrim(findings), '') IS NOT NULL),
    CONSTRAINT background_verifications_period
        CHECK (valid_until IS NULL OR completed_on IS NULL OR valid_until > completed_on)
);

-- One request of a kind in flight per employee. Two open police verifications
-- means two agencies were paid for the same check.
CREATE UNIQUE INDEX background_verifications_one_open
    ON background_verifications (employee_id, kind)
 WHERE status IN ('requested','in_progress');

CREATE INDEX background_verifications_expiring
    ON background_verifications (institution_id, valid_until) WHERE status = 'clear';

-- ---------------------------------------------------------------- welfare

/* The staff grievance cell.

   Anonymity is enforced rather than promised. A channel that says "anonymous"
   on the form and stores the reporter's user id is worse than no channel: the
   staff learn what it really does the first time somebody is asked about a
   complaint they thought was untraceable. */
CREATE TABLE staff_grievances (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    reference_no    text        NOT NULL,
    employee_id     uuid        REFERENCES employees(id) ON DELETE SET NULL,
    raised_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    is_anonymous    boolean     NOT NULL DEFAULT false,
    category        text        NOT NULL DEFAULT 'other',
    severity        text        NOT NULL DEFAULT 'medium',
    subject         text        NOT NULL,
    description     text        NOT NULL,
    status          text        NOT NULL DEFAULT 'open',
    assigned_to     uuid        REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at timestamptz,
    resolved_at     timestamptz,
    resolution      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_grievances_category
        CHECK (category IN ('harassment','pay','workload','facilities','discrimination',
                            'safety','management','other')),
    CONSTRAINT staff_grievances_severity CHECK (severity IN ('low','medium','high')),
    CONSTRAINT staff_grievances_status
        CHECK (status IN ('open','acknowledged','investigating','resolved','closed','withdrawn')),
    CONSTRAINT staff_grievances_anonymous_is_anonymous
        CHECK (NOT is_anonymous OR (employee_id IS NULL AND raised_by IS NULL)),
    CONSTRAINT staff_grievances_named_has_a_name
        CHECK (is_anonymous OR employee_id IS NOT NULL OR raised_by IS NOT NULL),
    -- Closing a complaint without writing down what was done is how a
    -- grievance cell becomes a place complaints go to disappear.
    CONSTRAINT staff_grievances_resolved_is_explained
        CHECK (status NOT IN ('resolved','closed') OR nullif(btrim(resolution), '') IS NOT NULL),
    CONSTRAINT staff_grievances_resolved_is_dated
        CHECK ((resolved_at IS NULL) OR status IN ('resolved','closed'))
);

CREATE UNIQUE INDEX staff_grievances_reference
    ON staff_grievances (institution_id, reference_no);

CREATE INDEX staff_grievances_open
    ON staff_grievances (institution_id, created_at DESC)
 WHERE status NOT IN ('resolved','closed','withdrawn');

CREATE TRIGGER staff_grievances_touch BEFORE UPDATE ON staff_grievances
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

/* The staff wall: awards, peer praise and long-service notes. */
CREATE TABLE staff_recognitions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- Null means the whole school rather than one campus, which is why it has
    -- to be coalesced in the uniqueness index below.
    campus_id       uuid        REFERENCES campuses(id) ON DELETE CASCADE,
    award_code      text        NOT NULL DEFAULT 'peer_praise',
    title           text        NOT NULL,
    citation        text,
    period_year     integer,
    period_month    integer,
    awarded_on      date        NOT NULL DEFAULT CURRENT_DATE,
    nominated_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    published       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_recognitions_award
        CHECK (award_code IN ('teacher_of_the_month','peer_praise','long_service',
                              'achievement','student_choice','principals_commendation')),
    CONSTRAINT staff_recognitions_month
        CHECK (period_month IS NULL OR period_month BETWEEN 1 AND 12),
    -- An award named for a month has to say which month.
    CONSTRAINT staff_recognitions_periodic_awards_have_a_period
        CHECK (award_code <> 'teacher_of_the_month'
               OR (period_year IS NOT NULL AND period_month IS NOT NULL))
);

/* There is one teacher of the month.

   campus_id is nullable and a null inside a unique index disables it row by
   row: without the coalesce, two school-wide awards for the same August both
   insert happily and the wall shows both. The zero uuid is not a campus, so
   it can never collide with a real one. */
CREATE UNIQUE INDEX staff_recognitions_one_per_period
    ON staff_recognitions (institution_id, award_code, period_year, period_month,
                           COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE award_code = 'teacher_of_the_month';

CREATE INDEX staff_recognitions_wall
    ON staff_recognitions (institution_id, awarded_on DESC) WHERE published;

/* What has already been wished.

   Birthdays and anniversaries are derived from employees.date_of_birth and
   employees.joined_on — storing them again would give the school two answers
   to one question. What cannot be derived is whether the greeting went out,
   and a system that wishes the same person four times on the same morning is
   one the staff stop reading. */
CREATE TABLE staff_celebration_greetings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id     uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind            text        NOT NULL,
    on_date         date        NOT NULL,
    -- Years completed, for an anniversary. A birthday's age is the employee's
    -- business and is deliberately not published on the wall.
    years           integer,
    greeted_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    greeted_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_celebration_kind CHECK (kind IN ('birthday','work_anniversary')),
    CONSTRAINT staff_celebration_years
        CHECK (kind <> 'work_anniversary' OR years IS NOT NULL)
);

CREATE UNIQUE INDEX staff_celebration_greetings_once
    ON staff_celebration_greetings (employee_id, kind, on_date);

-- ------------------------------------------------------------ leave policy

/* The rules leave_requests and staff_attendance already obey implicitly.

   One row per school, columns rather than a settings blob, for the same
   reason payroll_settings is: these are numbers a principal edits and an
   accountant is asked to justify, and a jsonb field nobody can constrain is
   where a wrong rule hides.

   Everything here is read by staff_lop_register below, which is the single
   place the rules turn into days. Payroll counted raw absences before this
   existed, so a school with a ten-minute grace period and a three-late-marks
   rule was deducting nothing for lateness at all. */
CREATE TABLE leave_policy (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- What half a day costs. Stored rather than assumed to be 0.5: schools
    -- with a six-period morning and an eight-period day do not split evenly.
    half_day_fraction numeric(3,2) NOT NULL DEFAULT 0.50,

    -- Late arrival. The grace window is the ten minutes a bus is allowed to be
    -- late; past it the day earns a late mark, and enough marks make a day.
    shift_starts_at time  NOT NULL DEFAULT '09:00',
    grace_minutes   integer NOT NULL DEFAULT 10,
    late_marks_per_lop_day integer NOT NULL DEFAULT 3,
    -- Past this, the morning is gone and the day is half. Null switches the
    -- rule off rather than making it zero, which would charge every arrival.
    late_half_day_after_minutes integer,

    -- What becomes loss of pay.
    lop_on_absent     boolean NOT NULL DEFAULT true,
    lop_on_unpaid_leave boolean NOT NULL DEFAULT true,
    -- Rounding is the school's, not ours. A half-day rule that produces 2.33
    -- days and a payslip that shows 2.5 need one place where the difference is
    -- decided.
    lop_rounding    text    NOT NULL DEFAULT 'half',
    max_lop_days_per_month numeric(4,1),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT leave_policy_half_day CHECK (half_day_fraction > 0 AND half_day_fraction <= 1),
    CONSTRAINT leave_policy_grace CHECK (grace_minutes BETWEEN 0 AND 240),
    CONSTRAINT leave_policy_late_marks CHECK (late_marks_per_lop_day > 0),
    CONSTRAINT leave_policy_late_half_day
        CHECK (late_half_day_after_minutes IS NULL
               OR late_half_day_after_minutes > grace_minutes),
    CONSTRAINT leave_policy_rounding CHECK (lop_rounding IN ('none','half','up')),
    CONSTRAINT leave_policy_cap
        CHECK (max_lop_days_per_month IS NULL OR max_lop_days_per_month > 0)
);

/* The rules one leave type obeys.

   Keyed on leave_types rather than replacing it: name, code, annual quota,
   whether it is paid and whether it carries forward are already there and are
   not repeated here. What is missing from that table is everything that makes
   a *policy* — how much may carry, how much notice is needed, whether a
   probationer may take it at all. */
CREATE TABLE leave_policy_rules (
    leave_type_id   uuid PRIMARY KEY REFERENCES leave_types(id) ON DELETE CASCADE,
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    accrual         text        NOT NULL DEFAULT 'annual',
    -- leave_types.carry_forward says whether; this says how much. A boolean
    -- with no cap is how a teacher arrives at retirement with 340 days.
    carry_forward_max numeric(5,1),
    encashable      boolean     NOT NULL DEFAULT false,
    allow_half_day  boolean     NOT NULL DEFAULT true,
    max_consecutive_days numeric(5,1),
    notice_days     integer     NOT NULL DEFAULT 0,
    -- Sick leave beyond a few days needs a certificate. The number is the
    -- school's; null means never.
    document_required_after_days numeric(5,1),
    available_during_probation boolean NOT NULL DEFAULT false,
    -- Maternity and paternity leave are the reason this exists. Null means
    -- everybody.
    applies_to_gender text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT leave_policy_rules_accrual CHECK (accrual IN ('annual','monthly','none')),
    CONSTRAINT leave_policy_rules_gender
        CHECK (applies_to_gender IS NULL OR applies_to_gender IN ('male','female','other')),
    CONSTRAINT leave_policy_rules_notice CHECK (notice_days BETWEEN 0 AND 365),
    CONSTRAINT leave_policy_rules_max_days
        CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
    CONSTRAINT leave_policy_rules_carry
        CHECK (carry_forward_max IS NULL OR carry_forward_max >= 0)
);

CREATE INDEX leave_policy_rules_institution ON leave_policy_rules (institution_id);

CREATE TRIGGER leave_policy_touch BEFORE UPDATE ON leave_policy
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER leave_policy_rules_touch BEFORE UPDATE ON leave_policy_rules
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER staff_qualifications_touch BEFORE UPDATE ON staff_qualifications
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER background_verifications_touch BEFORE UPDATE ON background_verifications
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- +goose StatementBegin
/* A policy nothing enforces is a page of good intentions.

   Applied in the database because leave arrives from the staff self-service
   screen, the HR queue and any import a school runs, and a rule true of one
   of those is not a rule. Only the structural limits are enforced here — a
   half day where half days are not allowed, a fortnight where a week is the
   maximum, a maternity leave against a man. Balance is deliberately not
   checked: leave_balances is maintained by the approval path, and refusing
   the application is the wrong place to argue about it. */
CREATE FUNCTION leave_request_obeys_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    rule   leave_policy_rules%ROWTYPE;
    gender text;
BEGIN
    IF NEW.subject_kind <> 'staff' OR NEW.leave_type_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO rule FROM leave_policy_rules WHERE leave_type_id = NEW.leave_type_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.is_half_day AND NOT rule.allow_half_day THEN
        RAISE EXCEPTION 'this leave type cannot be taken as a half day'
            USING ERRCODE = 'check_violation';
    END IF;
    IF rule.max_consecutive_days IS NOT NULL AND NEW.days > rule.max_consecutive_days THEN
        RAISE EXCEPTION 'at most % consecutive day(s) of this leave may be taken',
            rule.max_consecutive_days USING ERRCODE = 'check_violation';
    END IF;
    IF rule.notice_days > 0 AND NEW.from_date < CURRENT_DATE + rule.notice_days THEN
        RAISE EXCEPTION 'this leave needs % day(s) notice', rule.notice_days
            USING ERRCODE = 'check_violation';
    END IF;
    IF rule.applies_to_gender IS NOT NULL THEN
        SELECT e.gender INTO gender FROM employees e WHERE e.id = NEW.employee_id;
        IF gender IS DISTINCT FROM rule.applies_to_gender THEN
            RAISE EXCEPTION 'this leave type is available to % staff only', rule.applies_to_gender
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER leave_requests_obey_policy
    BEFORE INSERT ON leave_requests
    FOR EACH ROW EXECUTE FUNCTION leave_request_obeys_policy();

-- +goose StatementBegin
/*
staff_lop_register turns a month of attendance into days of loss of pay.

	This is the contract payroll reads. runPayroll counted rows where
	staff_attendance.status = 'absent' and nothing else, so a school running a
	grace period, a late-mark rule or unpaid leave was deducting for none of
	them — and the half_day status, which the register has been able to record
	since the baseline, cost the employee nothing at all.

	Every day lands in exactly one bucket. Sharing a day between "absent" and
	"unpaid leave" would double-charge it, and the mutual exclusion is why the
	arithmetic is a single CASE rather than four counts added together.

	Late marks accumulate and convert in whole days: three marks make one day
	and the fourth waits for the next two. Carrying the remainder into the
	following month would be defensible and is not done, because a teacher
	cannot then be told what a month cost them until the year ends.
*/
CREATE FUNCTION staff_lop_register(p_institution uuid, p_year integer, p_month integer)
RETURNS TABLE (
    user_id           uuid,
    employee_id       uuid,
    absent_days       numeric,
    half_days         numeric,
    unpaid_leave_days numeric,
    late_marks        integer,
    lop_days          numeric
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    pol        leave_policy%ROWTYPE;
    first_day  date := make_date(p_year, p_month, 1);
    last_day   date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
BEGIN
    SELECT * INTO pol FROM leave_policy p WHERE p.institution_id = p_institution;
    IF NOT FOUND THEN
        -- A school that has never opened the policy screen still runs payroll,
        -- and these are the same defaults the table carries.
        pol.half_day_fraction := 0.50;
        pol.shift_starts_at := TIME '09:00';
        pol.grace_minutes := 10;
        pol.late_marks_per_lop_day := 3;
        pol.late_half_day_after_minutes := NULL;
        pol.lop_on_absent := true;
        pol.lop_on_unpaid_leave := true;
        pol.lop_rounding := 'half';
        pol.max_lop_days_per_month := NULL;
    END IF;

    RETURN QUERY
    WITH marked AS (
        SELECT sa.user_id AS uid,
               e.id       AS eid,
               sa.status,
               COALESCE(lr.is_half_day, false) AS half_leave,
               COALESCE(lt.is_paid, false)     AS paid_leave,
               CASE WHEN sa.check_in IS NULL THEN NULL ELSE
                    GREATEST(0, (EXTRACT(epoch FROM
                        (sa.check_in AT TIME ZONE 'Asia/Kolkata')::time - pol.shift_starts_at
                    ) / 60)::integer)
               END AS late_minutes
          FROM staff_attendance sa
          JOIN employees e ON e.user_id = sa.user_id
                          AND e.institution_id = sa.institution_id
          /* The approved leave covering the day, if any. staff_attendance
             records that somebody was on leave; only the request knows which
             type, and only the type knows whether it was paid. */
          LEFT JOIN LATERAL (
              SELECT r.is_half_day, r.leave_type_id
                FROM leave_requests r
               WHERE r.employee_id = e.id
                 AND r.subject_kind = 'staff'
                 AND r.status = 'approved'
                 AND sa.on_date BETWEEN r.from_date AND r.to_date
               ORDER BY r.from_date DESC
               LIMIT 1
          ) lr ON true
          LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
         WHERE sa.institution_id = p_institution
           AND sa.on_date BETWEEN first_day AND last_day
    ),
    priced AS (
        SELECT m.uid, m.eid, m.status,
               CASE
                 WHEN m.status = 'absent'
                      THEN CASE WHEN pol.lop_on_absent THEN 1.0 ELSE 0 END
                 WHEN m.status = 'half_day' THEN pol.half_day_fraction
                 WHEN m.status = 'leave' THEN
                      CASE WHEN pol.lop_on_unpaid_leave AND NOT m.paid_leave
                           THEN CASE WHEN m.half_leave THEN pol.half_day_fraction ELSE 1.0 END
                           ELSE 0 END
                 WHEN pol.late_half_day_after_minutes IS NOT NULL
                      AND COALESCE(m.late_minutes, 0) >= pol.late_half_day_after_minutes
                      THEN pol.half_day_fraction
                 ELSE 0
               END::numeric AS charged,
               CASE
                 WHEN m.status IN ('absent','half_day','leave','holiday','week_off') THEN 0
                 WHEN pol.late_half_day_after_minutes IS NOT NULL
                      AND COALESCE(m.late_minutes, 0) >= pol.late_half_day_after_minutes THEN 0
                 WHEN m.status = 'late' OR COALESCE(m.late_minutes, 0) > pol.grace_minutes THEN 1
                 ELSE 0
               END AS late_mark,
               CASE WHEN m.status = 'leave' AND NOT m.paid_leave
                    THEN CASE WHEN m.half_leave THEN 0.5 ELSE 1.0 END ELSE 0 END::numeric
                 AS unpaid_leave
          FROM marked m
    ),
    tallied AS (
        SELECT p.uid, p.eid,
               count(*) FILTER (WHERE p.status = 'absent')::numeric   AS absent,
               count(*) FILTER (WHERE p.status = 'half_day')::numeric AS halves,
               sum(p.unpaid_leave)                                    AS unpaid,
               sum(p.late_mark)::integer                              AS marks,
               sum(p.charged)                                         AS charged
          FROM priced p
         GROUP BY p.uid, p.eid
    ),
    raw AS (
        SELECT t.*,
               t.charged + floor(t.marks::numeric / pol.late_marks_per_lop_day) AS gross_lop
          FROM tallied t
    )
    -- Rounded to two places on the way out: numeric division carries twenty
    -- decimals that mean nothing to a payslip and read as noise in JSON.
    SELECT r.uid, r.eid, r.absent, r.halves, r.unpaid, r.marks,
           round(LEAST(
               CASE WHEN pol.max_lop_days_per_month IS NULL THEN rounded.v
                    ELSE LEAST(rounded.v, pol.max_lop_days_per_month) END,
               (last_day - first_day + 1)::numeric
           ), 2)
      FROM raw r
      CROSS JOIN LATERAL (
          SELECT CASE pol.lop_rounding
                   WHEN 'up'   THEN ceil(r.gross_lop)
                   WHEN 'half' THEN round(r.gross_lop * 2) / 2
                   ELSE r.gross_lop
                 END AS v
      ) rounded;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
/*
The same register for the caller's own school.

	Payroll already runs inside a tenant transaction, so making it name the
	institution again would be one more place for the two to disagree.
*/
CREATE FUNCTION staff_lop_register(p_year integer, p_month integer)
RETURNS TABLE (
    user_id           uuid,
    employee_id       uuid,
    absent_days       numeric,
    half_days         numeric,
    unpaid_leave_days numeric,
    late_marks        integer,
    lop_days          numeric
)
LANGUAGE sql STABLE
AS $$
    SELECT * FROM staff_lop_register(app_current_institution(), p_year, p_month);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
/*
staff_lop_days is one employee's loss of pay for one month.

	The scalar form exists for callers that already have a row in hand. Anything
	looping over staff should join the register instead: this re-runs the whole
	month per call.
*/
CREATE FUNCTION staff_lop_days(p_institution uuid, p_user uuid,
                               p_year integer, p_month integer)
RETURNS numeric
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((SELECT r.lop_days
                       FROM staff_lop_register(p_institution, p_year, p_month) r
                      WHERE r.user_id = p_user), 0)::numeric;
$$;
-- +goose StatementEnd

-- ------------------------------------------------------------------- tenancy

ALTER TABLE staff_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_onboarding FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_exits FORCE ROW LEVEL SECURITY;
ALTER TABLE clearance_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE clearance_departments FORCE ROW LEVEL SECURITY;
ALTER TABLE exit_clearances ENABLE ROW LEVEL SECURITY;
ALTER TABLE exit_clearances FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE service_book_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_book_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_qualifications FORCE ROW LEVEL SECURITY;
ALTER TABLE medical_fitness_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE medical_fitness_certificates FORCE ROW LEVEL SECURITY;
ALTER TABLE background_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_grievances ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_grievances FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_recognitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_recognitions FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_celebration_greetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_celebration_greetings FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_policy_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policy_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_onboarding_tenant ON staff_onboarding
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_exits_tenant ON staff_exits
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY clearance_departments_tenant ON clearance_departments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY exit_clearances_tenant ON exit_clearances
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_transfers_tenant ON staff_transfers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY service_book_entries_tenant ON service_book_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_qualifications_tenant ON staff_qualifications
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY medical_fitness_certificates_tenant ON medical_fitness_certificates
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY background_verifications_tenant ON background_verifications
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_grievances_tenant ON staff_grievances
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_recognitions_tenant ON staff_recognitions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY staff_celebration_greetings_tenant ON staff_celebration_greetings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY leave_policy_tenant ON leave_policy
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY leave_policy_rules_tenant ON leave_policy_rules
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose StatementBegin
/* Give every school the defaults, so the screens work on the day this ships
   rather than after somebody finds a setup page.

   institutions is itself under FORCE row-level security, so without the
   set_config the loop below sees no rows and seeds nothing at all — silently,
   because iterating an empty result is not an error. */
DO $$
DECLARE inst uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        INSERT INTO leave_policy (institution_id) VALUES (inst)
        ON CONFLICT DO NOTHING;

        -- The departments a teacher is signed out of. A day school switches
        -- the hostel off; it is not deleted, because exits already raised
        -- against it must keep reading.
        INSERT INTO clearance_departments (institution_id, code, name, sequence)
        VALUES (inst, 'library',   'Library',            10),
               (inst, 'lab',       'Science laboratories', 20),
               (inst, 'it',        'IT and devices',     30),
               (inst, 'stores',    'Stores and stationery', 40),
               (inst, 'hostel',    'Hostel',             50),
               (inst, 'transport', 'Transport',          60),
               (inst, 'finance',   'Accounts',           70),
               (inst, 'hr',        'HR and records',     80)
        ON CONFLICT DO NOTHING;

        -- A permissive rule row per staff leave type: every limit starts unset,
        -- so seeding this changes no existing behaviour and gives the policy
        -- screen something to edit.
        INSERT INTO leave_policy_rules (leave_type_id, institution_id)
        SELECT lt.id, inst FROM leave_types lt
         WHERE lt.institution_id = inst AND lt.applies_to = 'staff'
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS leave_requests_obey_policy ON leave_requests;
DROP FUNCTION IF EXISTS leave_request_obeys_policy();
DROP FUNCTION IF EXISTS staff_lop_days(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS staff_lop_register(integer, integer);
DROP FUNCTION IF EXISTS staff_lop_register(uuid, integer, integer);
DROP TABLE IF EXISTS leave_policy_rules;
DROP TABLE IF EXISTS leave_policy;
DROP TABLE IF EXISTS staff_celebration_greetings;
DROP TABLE IF EXISTS staff_recognitions;
DROP TABLE IF EXISTS staff_grievances;
DROP TABLE IF EXISTS background_verifications;
DROP TABLE IF EXISTS medical_fitness_certificates;
DROP TABLE IF EXISTS staff_qualifications;
DROP TABLE IF EXISTS service_book_entries;
DROP FUNCTION IF EXISTS service_book_attested_is_final();
DROP TABLE IF EXISTS staff_transfers;
DROP TABLE IF EXISTS exit_clearances;
DROP TABLE IF EXISTS clearance_departments;
DROP TABLE IF EXISTS staff_exits;
DROP FUNCTION IF EXISTS hr_settlement_needs_clearance();
DROP TABLE IF EXISTS staff_onboarding;
