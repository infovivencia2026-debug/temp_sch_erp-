-- Renumbered from 00034: 00035 had already been applied by the time this
-- merged, and goose refuses a migration that appears behind the current
-- version. The content is unchanged.
-- +goose Up
-- What a principal's office keeps that no register in this product held yet.
--
-- Ten screens sit on this file, and eight of them needed no new table at all:
-- the school calendar is holidays, marks monitoring is marks, allocation is
-- section_subject_teachers, the substitution board is substitutions, the
-- department roll is enrollments read through the department's teachers, and
-- print templates are certificate_types. Only outcomes, the council and the
-- alumni programme are genuinely new things to record.
--
-- The three ALTERs below widen tables another module already owns rather than
-- opening a parallel one. A second discipline table would mean a suspension a
-- class teacher's screen cannot see, and a second certificate table would mean
-- two answers to "what does a bonafide look like".

/* One calendar entry per school, per day, per kind, per name.

   holidays has carried no uniqueness since the baseline, so "Diwali" could be
   entered twice on the same date by two people and every working-day count
   downstream would quietly be one short. campus_id and academic_year_id are
   nullable — an entry that applies to the whole trust names no campus — and a
   NULL inside a unique index silently disables it for exactly the rows that
   need it most, so the campus is folded to the nil uuid in the key. */
CREATE UNIQUE INDEX holidays_one_entry ON holidays (
    institution_id,
    COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
    on_date, kind, lower(name));

/* The disciplinary incident log, on the table that already holds conduct notes.

   discipline_records is what a subject teacher writes "did not bring the
   notebook, third time" into, and my_classes.go reads it that way. An incident
   is the same row escalated: it acquires a severity, a status somebody has to
   close, and — when it comes to that — the dates a child was out of school.

   Every column is nullable or defaulted, because the teacher's insert path
   names none of them and must keep working unchanged. */
ALTER TABLE discipline_records
    -- How serious the school judged it. Not derived from category: "fighting"
    -- covers a shove in a queue and a hospital visit, and only the person who
    -- saw it knows which.
    ADD COLUMN severity            text NOT NULL DEFAULT 'minor',
    -- An incident nobody closed is the one an inspection asks about. Default
    -- 'open' rather than 'closed' so a note left alone reads as outstanding.
    ADD COLUMN status              text NOT NULL DEFAULT 'open',
    ADD COLUMN follow_up_on        date,
    ADD COLUMN suspension_from     date,
    ADD COLUMN suspension_to       date,
    -- The parent meeting is a separate fact from the parent being notified.
    -- parent_notified already means "we sent word"; this means "they came in".
    ADD COLUMN parent_meeting_on   date,
    ADD COLUMN parent_meeting_note text,
    -- Kept apart from description so that pastoral notes are not printed in a
    -- conduct extract by a handler that just selects the narrative column.
    ADD COLUMN counselling_note    text,
    ADD COLUMN closed_on           date,
    ADD COLUMN closed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT discipline_records_severity
        CHECK (severity IN ('minor','major','serious')),
    ADD CONSTRAINT discipline_records_status
        CHECK (status IN ('open','under_review','action_taken','closed')),
    -- A closed incident with no date closed cannot be aged, and an ageing
    -- report is the only reason the status column earns its keep.
    ADD CONSTRAINT discipline_records_closed_has_date
        CHECK (status <> 'closed' OR closed_on IS NOT NULL),
    ADD CONSTRAINT discipline_records_suspension_range
        CHECK (suspension_to IS NULL
               OR (suspension_from IS NOT NULL AND suspension_to >= suspension_from)),
    -- A commendation that suspends a child is a data-entry accident, and the
    -- child is the one who pays for it.
    ADD CONSTRAINT discipline_records_positive_is_not_punishment
        CHECK (NOT is_positive OR (suspension_from IS NULL AND suspension_to IS NULL));

-- The office's own view: everything still open, worst first.
CREATE INDEX discipline_records_open
    ON discipline_records (institution_id, status, occurred_on DESC)
    WHERE status <> 'closed';

/* Print templates, on the certificate register that already exists.

   certificate_types already carries code, name, requires_approval and a
   template_html nobody had a screen for. What was missing is everything a
   school actually asks about a template: whether it is still in use, whose
   signature goes at the bottom, and what the serial should look like. */
ALTER TABLE certificate_types
    -- A transfer certificate and a service certificate print from the same
    -- table; without this the student screen offers the staff templates.
    ADD COLUMN subject_kind text NOT NULL DEFAULT 'student',
    -- Retired rather than deleted: issued_certificates references the type
    -- with ON DELETE RESTRICT, so a school's only way to stop offering an old
    -- format has to be a flag.
    ADD COLUMN is_active    boolean NOT NULL DEFAULT true,
    ADD COLUMN description  text,
    ADD COLUMN page_size    text NOT NULL DEFAULT 'A4',
    ADD COLUMN orientation  text NOT NULL DEFAULT 'portrait',
    -- The serial a school wants on the paper — "TC/2026/" — kept with the
    -- template because that is where the person designing it is looking.
    ADD COLUMN serial_prefix text,
    ADD COLUMN signatory     text,
    ADD COLUMN signatory_role text,
    ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT certificate_types_subject_kind
        CHECK (subject_kind IN ('student','staff')),
    ADD CONSTRAINT certificate_types_page_size
        CHECK (page_size IN ('A4','A5','Letter','Legal')),
    ADD CONSTRAINT certificate_types_orientation
        CHECK (orientation IN ('portrait','landscape'));

/* --- Outcome-based education -------------------------------------------------

   CO/PO attainment, for the schools running an affiliated junior college or a
   board that asks for it. Nothing here stores an attainment percentage: it is
   computed from marks on read, for the same reason syllabus coverage is. A
   stored number is wrong the moment a paper is re-marked and nobody remembers
   to recompute it. */

/* What the programme as a whole claims to produce. */
CREATE TABLE programme_outcomes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    code           text NOT NULL,
    statement      text NOT NULL,
    -- A programme-specific outcome is written by the department rather than
    -- taken from the board's list, and reports separate the two.
    kind           text NOT NULL DEFAULT 'po',
    sequence       integer NOT NULL DEFAULT 1,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT programme_outcomes_kind CHECK (kind IN ('po','pso'))
);
-- PO1 and po1 are the same outcome to everyone except a unique index.
CREATE UNIQUE INDEX programme_outcomes_code
    ON programme_outcomes (institution_id, upper(code));

/* What one subject in one class claims to produce. */
CREATE TABLE course_outcomes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    code             text NOT NULL,
    statement        text NOT NULL,
    bloom_level      text,
    -- The two bars, stated per outcome because departments genuinely set them
    -- differently: a child attains the outcome by scoring threshold_percent on
    -- the papers mapped to it, and the outcome is attained when target_percent
    -- of the class clear that bar. Holding them here rather than in the
    -- reporting code is what stops two screens disagreeing about the same CO.
    threshold_percent integer NOT NULL DEFAULT 50,
    target_percent    integer NOT NULL DEFAULT 60,
    sequence          integer NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT course_outcomes_bloom CHECK (bloom_level IS NULL OR bloom_level IN
        ('remember','understand','apply','analyse','evaluate','create')),
    CONSTRAINT course_outcomes_threshold CHECK (threshold_percent BETWEEN 1 AND 100),
    CONSTRAINT course_outcomes_target CHECK (target_percent BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX course_outcomes_code
    ON course_outcomes (class_subject_id, upper(code));
CREATE INDEX course_outcomes_institution ON course_outcomes (institution_id);

/* Which course outcome feeds which programme outcome, and how strongly. */
CREATE TABLE co_po_map (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id       uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    course_outcome_id    uuid NOT NULL REFERENCES course_outcomes(id) ON DELETE CASCADE,
    programme_outcome_id uuid NOT NULL REFERENCES programme_outcomes(id) ON DELETE CASCADE,
    -- The 1-2-3 every accreditation form in India uses. Stored as the number
    -- rather than 'low'/'medium'/'high' because it is averaged, not displayed.
    strength             integer NOT NULL DEFAULT 1,
    UNIQUE (course_outcome_id, programme_outcome_id),
    CONSTRAINT co_po_map_strength CHECK (strength BETWEEN 1 AND 3)
);
CREATE INDEX co_po_map_institution ON co_po_map (institution_id);

/* Which paper measures which course outcome.

   This is the join that makes attainment computable at all: without it a CO is
   a sentence in a file and the marks table is a pile of numbers with no
   relationship to it. */
CREATE TABLE outcome_assessments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    course_outcome_id uuid NOT NULL REFERENCES course_outcomes(id) ON DELETE CASCADE,
    exam_subject_id   uuid NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    -- What share of the paper tests this outcome. A paper split across three
    -- outcomes is the normal case, and scoring all three off the whole paper
    -- would make every one of them look identically attained.
    weight            numeric(5,2) NOT NULL DEFAULT 100,
    UNIQUE (course_outcome_id, exam_subject_id),
    CONSTRAINT outcome_assessments_weight CHECK (weight > 0 AND weight <= 100)
);
CREATE INDEX outcome_assessments_institution ON outcome_assessments (institution_id);

/* --- The student council -----------------------------------------------------

   A post, the child who holds it, and what they were actually asked to do.
   Modelled as three tables rather than a "head boy" column on students because
   a council is re-elected every year and last year's holder is the fact a
   testimonial is written from. */

CREATE TABLE council_positions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- Not nullable: a council belongs to a year, and a post with no year
    -- accumulates every holder it has ever had into one list.
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    title            text NOT NULL,
    portfolio        text,
    -- Four house captains are one post with four seats, not four posts.
    seats            integer NOT NULL DEFAULT 1,
    is_elected       boolean NOT NULL DEFAULT true,
    sequence         integer NOT NULL DEFAULT 1,
    description      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT council_positions_seats CHECK (seats BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX council_positions_title
    ON council_positions (academic_year_id, lower(title));
CREATE INDEX council_positions_institution ON council_positions (institution_id);

CREATE TABLE council_members (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    position_id    uuid NOT NULL REFERENCES council_positions(id) ON DELETE CASCADE,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    elected_on     date,
    -- Defaulted rather than nullable because it is part of the key below, and
    -- a NULL there would let the same child be appointed twice over.
    term_from      date NOT NULL DEFAULT current_date,
    term_to        date,
    votes          integer,
    status         text NOT NULL DEFAULT 'serving',
    remarks        text,
    recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (position_id, student_id, term_from),
    CONSTRAINT council_members_status
        CHECK (status IN ('serving','completed','resigned','removed')),
    CONSTRAINT council_members_term CHECK (term_to IS NULL OR term_to >= term_from),
    CONSTRAINT council_members_votes CHECK (votes IS NULL OR votes >= 0)
);
CREATE INDEX council_members_institution ON council_members (institution_id);
CREATE INDEX council_members_student ON council_members (student_id);

/* What a council member was asked to do, and whether it happened.

   The point of the table: "she was head girl" is worth nothing in a
   testimonial, and "she ran the assembly rota for three terms" is worth
   something. */
CREATE TABLE council_duties (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    member_id      uuid NOT NULL REFERENCES council_members(id) ON DELETE CASCADE,
    on_date        date NOT NULL DEFAULT current_date,
    duty           text NOT NULL,
    notes          text,
    performed      boolean NOT NULL DEFAULT false,
    recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX council_duties_member ON council_duties (member_id, on_date DESC);
CREATE INDEX council_duties_institution ON council_duties (institution_id);

/* --- The alumni programme ----------------------------------------------------

   students.status already has an 'alumni' value, so the directory is not a
   second copy of the child: it is the handful of facts a school only learns
   after they leave, hung off the student row that already exists. */

CREATE TABLE alumni_profiles (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The year they left, denormalised from the last enrollment because that
    -- is how every alumni list is grouped and the enrollment may be archived.
    batch_year     integer NOT NULL,
    occupation     text,
    employer       text,
    higher_study   text,
    city           text,
    country        text NOT NULL DEFAULT 'India',
    email          citext,
    phone          text,
    -- Consent, not a preference. An alumnus who asked to be left alone must
    -- drop out of every mailing the office runs, and a flag on the profile is
    -- the only place a bulk send will actually look.
    contactable    boolean NOT NULL DEFAULT true,
    notes          text,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (student_id),
    CONSTRAINT alumni_profiles_batch CHECK (batch_year BETWEEN 1900 AND 2200)
);
CREATE INDEX alumni_profiles_batch ON alumni_profiles (institution_id, batch_year DESC);

CREATE TABLE alumni_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
    title            text NOT NULL,
    on_date          date NOT NULL,
    venue            text,
    description      text,
    expected         integer,
    status           text NOT NULL DEFAULT 'planned',
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alumni_events_status
        CHECK (status IN ('planned','open','held','cancelled')),
    CONSTRAINT alumni_events_expected CHECK (expected IS NULL OR expected >= 0)
);
CREATE UNIQUE INDEX alumni_events_one_per_day
    ON alumni_events (institution_id, on_date, lower(title));

CREATE TABLE alumni_event_rsvps (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    event_id          uuid NOT NULL REFERENCES alumni_events(id) ON DELETE CASCADE,
    alumni_profile_id uuid NOT NULL REFERENCES alumni_profiles(id) ON DELETE CASCADE,
    rsvp              text NOT NULL DEFAULT 'invited',
    -- Separate from rsvp on purpose: the gap between who said yes and who came
    -- is the number the office plans next year's catering from.
    attended          boolean NOT NULL DEFAULT false,
    guests            integer NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, alumni_profile_id),
    CONSTRAINT alumni_event_rsvps_rsvp
        CHECK (rsvp IN ('invited','yes','no','maybe')),
    CONSTRAINT alumni_event_rsvps_guests CHECK (guests >= 0)
);
CREATE INDEX alumni_event_rsvps_institution ON alumni_event_rsvps (institution_id);

/* What an alumnus gave.

   Deliberately not an invoice or a payment: those tables are the fee ledger
   and a donation posted there would appear as school income against a student
   account. The accounting entry, when a school wants one, is a journal voucher
   raised from this row — not this row pretending to be one. */
CREATE TABLE alumni_contributions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    alumni_profile_id uuid NOT NULL REFERENCES alumni_profiles(id) ON DELETE CASCADE,
    event_id          uuid REFERENCES alumni_events(id) ON DELETE SET NULL,
    received_on       date NOT NULL DEFAULT current_date,
    -- Paise, like every other amount in this product.
    amount_paise      bigint NOT NULL,
    kind              text NOT NULL DEFAULT 'cash',
    purpose           text,
    receipt_no        text,
    acknowledged      boolean NOT NULL DEFAULT false,
    recorded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alumni_contributions_amount CHECK (amount_paise > 0),
    CONSTRAINT alumni_contributions_kind
        CHECK (kind IN ('cash','kind','scholarship','infrastructure'))
);
-- Unique only where a receipt was actually issued. A plain unique index would
-- be disabled by the NULLs and let the same receipt number be reused.
CREATE UNIQUE INDEX alumni_contributions_receipt
    ON alumni_contributions (institution_id, receipt_no)
    WHERE receipt_no IS NOT NULL;
CREATE INDEX alumni_contributions_profile
    ON alumni_contributions (alumni_profile_id, received_on DESC);
CREATE INDEX alumni_contributions_institution
    ON alumni_contributions (institution_id, received_on DESC);

-- --- tenant isolation --------------------------------------------------------
ALTER TABLE programme_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE course_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE co_po_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_po_map FORCE ROW LEVEL SECURITY;
ALTER TABLE outcome_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE council_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE council_positions FORCE ROW LEVEL SECURITY;
ALTER TABLE council_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE council_members FORCE ROW LEVEL SECURITY;
ALTER TABLE council_duties ENABLE ROW LEVEL SECURITY;
ALTER TABLE council_duties FORCE ROW LEVEL SECURITY;
ALTER TABLE alumni_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE alumni_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_events FORCE ROW LEVEL SECURITY;
ALTER TABLE alumni_event_rsvps ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_event_rsvps FORCE ROW LEVEL SECURITY;
ALTER TABLE alumni_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_contributions FORCE ROW LEVEL SECURITY;

CREATE POLICY programme_outcomes_tenant ON programme_outcomes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY course_outcomes_tenant ON course_outcomes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY co_po_map_tenant ON co_po_map
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY outcome_assessments_tenant ON outcome_assessments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY council_positions_tenant ON council_positions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY council_members_tenant ON council_members
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY council_duties_tenant ON council_duties
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_profiles_tenant ON alumni_profiles
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_events_tenant ON alumni_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_event_rsvps_tenant ON alumni_event_rsvps
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_contributions_tenant ON alumni_contributions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS alumni_contributions;
DROP TABLE IF EXISTS alumni_event_rsvps;
DROP TABLE IF EXISTS alumni_events;
DROP TABLE IF EXISTS alumni_profiles;
DROP TABLE IF EXISTS council_duties;
DROP TABLE IF EXISTS council_members;
DROP TABLE IF EXISTS council_positions;
DROP TABLE IF EXISTS outcome_assessments;
DROP TABLE IF EXISTS co_po_map;
DROP TABLE IF EXISTS course_outcomes;
DROP TABLE IF EXISTS programme_outcomes;

ALTER TABLE certificate_types
    DROP CONSTRAINT IF EXISTS certificate_types_orientation,
    DROP CONSTRAINT IF EXISTS certificate_types_page_size,
    DROP CONSTRAINT IF EXISTS certificate_types_subject_kind,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS signatory_role,
    DROP COLUMN IF EXISTS signatory,
    DROP COLUMN IF EXISTS serial_prefix,
    DROP COLUMN IF EXISTS orientation,
    DROP COLUMN IF EXISTS page_size,
    DROP COLUMN IF EXISTS description,
    DROP COLUMN IF EXISTS is_active,
    DROP COLUMN IF EXISTS subject_kind;

DROP INDEX IF EXISTS discipline_records_open;
ALTER TABLE discipline_records
    DROP CONSTRAINT IF EXISTS discipline_records_positive_is_not_punishment,
    DROP CONSTRAINT IF EXISTS discipline_records_suspension_range,
    DROP CONSTRAINT IF EXISTS discipline_records_closed_has_date,
    DROP CONSTRAINT IF EXISTS discipline_records_status,
    DROP CONSTRAINT IF EXISTS discipline_records_severity,
    DROP COLUMN IF EXISTS closed_by,
    DROP COLUMN IF EXISTS closed_on,
    DROP COLUMN IF EXISTS counselling_note,
    DROP COLUMN IF EXISTS parent_meeting_note,
    DROP COLUMN IF EXISTS parent_meeting_on,
    DROP COLUMN IF EXISTS suspension_to,
    DROP COLUMN IF EXISTS suspension_from,
    DROP COLUMN IF EXISTS follow_up_on,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS severity;

DROP INDEX IF EXISTS holidays_one_entry;
