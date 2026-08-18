-- Claimed as 00059; may be renumbered at integration. Content is independent of
-- every other in-flight migration and creates no table another worker creates.
--
-- Every comment here is `--` rather than a C-style block, because goose's
-- statement splitter counts semicolons without understanding block comments and
-- a `;` inside one truncates the statement at the wrong line.
--
-- Five classroom features that all had the same failure mode if built naively:
-- a second table holding a fact the schema already holds. So most of what
-- follows is a thin layer over tables that exist.
--
--   language allocation   the option IS a class_subjects row. Nothing new
--                         describes the subject; the new rows say which of the
--                         existing class-subjects a school offers in the second
--                         language slot, and which one each child sits in.
--   portfolio builder     student_achievements (school-awarded) and
--                         student_portfolio_items (the child's own claim) both
--                         exist and are deliberately separate. No third table:
--                         one curation row pointing at either of them.
--   montessori            NOT hpc_observations. See the note above
--                         montessori_progress for why extending it was wrong.
--   offline attendance    student_attendance keeps holding the register. Three
--                         columns say a row arrived from a device that was
--                         offline, one table records the sync, one records what
--                         the sync refused to overwrite.
--   no-OMR grading        question_bank_questions / question_bank_options /
--                         online_tests / online_test_questions are all built.
--                         What was missing was anybody's answers, so the two
--                         new tables are the attempt and the responses.

-- +goose Up

-- ===========================================================================
-- 1. faculty.my_classes.language_subject_allocation
-- ===========================================================================

-- Which languages a class offers, in which slot.
--
-- A school teaching Telugu, Hindi, Sanskrit and French does not teach them as
-- four unrelated subjects: it teaches a first language everyone takes, a second
-- language chosen from a list, and often a third. The slot is the thing the
-- timetable, the report card and the board entry all key off, and it is the one
-- fact class_subjects cannot express -- class_subjects.is_elective says a
-- subject is optional but not which choice it is an alternative to.
--
-- class_subject_id, not subject_id: the option a child elects has to be the row
-- the marks, the timetable and the exam already hang off, or the allocation is
-- a list that agrees with nothing. class_id is denormalised from it so the
-- option list for a class is one index lookup; a CHECK cannot enforce the
-- agreement across tables, so the API writes class_id from the class_subject.
CREATE TABLE class_language_options (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    class_id          uuid        NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    class_subject_id  uuid        NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    -- first is normally compulsory and offered as a single option; second and
    -- third are the real choices. Stored rather than inferred because a school
    -- that offers English and Telugu as alternative first languages exists.
    slot              text        NOT NULL
                                  CHECK (slot IN ('first', 'second', 'third')),
    -- What the school calls it on the option form, when that differs from the
    -- subject name: "Sanskrit (composite)".
    display_name      text,
    -- The size of the group the school can actually staff. NULL means no cap;
    -- the allocation screen reports over-subscription, it does not block it,
    -- because a section that has to take 41 children takes 41 children.
    capacity          integer     CHECK (capacity IS NULL OR capacity > 0),
    is_active         boolean     NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The same class-subject offered twice in the same slot is always a mistake and
-- it doubles the roster silently. No nullable column in the key, so a plain
-- UNIQUE is honest here.
CREATE UNIQUE INDEX class_language_options_once
    ON class_language_options (class_subject_id, slot);

CREATE INDEX class_language_options_class
    ON class_language_options (institution_id, class_id, slot)
    WHERE is_active;

-- What one child chose, for one slot, in one year.
--
-- academic_year_id because the choice is re-made on promotion -- a child who
-- took Hindi in Class 6 may take Sanskrit in Class 8, and overwriting last
-- year's row would rewrite the record the report card was printed from.
--
-- status carries 'proposed' separately from 'confirmed' because the parent's
-- form and the school's allocation are two different events, and the gap
-- between them is exactly what the allocation screen exists to show.
CREATE TABLE student_language_elections (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id        uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    option_id         uuid        NOT NULL REFERENCES class_language_options(id) ON DELETE CASCADE,
    -- Copied from the option so a slot can be queried without a join and so a
    -- child cannot end up holding two 'second language' rows through two
    -- different options. The API writes it; the unique index below depends on
    -- it being right.
    slot              text        NOT NULL
                                  CHECK (slot IN ('first', 'second', 'third')),
    academic_year_id  uuid        REFERENCES academic_years(id) ON DELETE SET NULL,
    status            text        NOT NULL DEFAULT 'confirmed'
                                  CHECK (status IN ('proposed', 'confirmed', 'withdrawn')),
    -- Why the school moved a child off their first choice. A reallocation with
    -- no reason is the one the parent phones about.
    note              text,
    decided_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    decided_on        date        NOT NULL DEFAULT CURRENT_DATE,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One live election per child per slot per year.
--
-- academic_year_id is nullable, and a bare UNIQUE over it would enforce nothing
-- at all -- the trap this repo has hit six times. COALESCE to a sentinel no year
-- can have. Withdrawn rows are excluded so a child can be moved from Hindi to
-- Sanskrit without deleting the history of having been in Hindi.
CREATE UNIQUE INDEX student_language_elections_one_live
    ON student_language_elections (
        student_id, slot,
        COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE status <> 'withdrawn';

CREATE INDEX student_language_elections_option
    ON student_language_elections (institution_id, option_id, status);

-- ===========================================================================
-- 2. faculty.my_classes.student_portfolio_builder
-- ===========================================================================

-- The teacher's side of a portfolio that already exists twice.
--
-- migration 00037 states the rule this obeys: "A school prize and a
-- self-declared hackathon are different kinds of claim." student_achievements
-- holds the first, student_portfolio_items holds the second, and a third table
-- merging them would destroy the distinction a university reading the portfolio
-- is entitled to. So this row curates rather than copies: it points at one item
-- in one of those two tables and records what the teacher did with it.
--
-- Exactly one of the two ids is set. The CHECK is a real xor rather than two
-- nullable columns nobody validates, because a curation pointing at neither is
-- a comment about nothing and one pointing at both is a comment about two
-- different children's evidence.
CREATE TABLE student_portfolio_curations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id     uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id         uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    achievement_id     uuid        REFERENCES student_achievements(id) ON DELETE CASCADE,
    portfolio_item_id  uuid        REFERENCES student_portfolio_items(id) ON DELETE CASCADE,
    -- endorsed  the school stands behind this claim
    -- noted     seen, kept, not vouched for
    -- returned  sent back to the child with a comment; still theirs, not shown
    -- The default is 'noted' rather than 'endorsed': a teacher opening the
    -- screen and typing a comment has not certified anything.
    status             text        NOT NULL DEFAULT 'noted'
                                   CHECK (status IN ('noted', 'endorsed', 'returned')),
    -- The sentence a parent reads next to the child's own description.
    comment            text,
    -- Two different audiences, deliberately not one flag. A piece can be worth
    -- printing on the report card and still not be the one shown on the
    -- portfolio wall, and a returned draft is neither.
    include_in_report  boolean     NOT NULL DEFAULT false,
    is_featured        boolean     NOT NULL DEFAULT false,
    -- Where it sits when featured. Ties break on curated_at.
    display_order      integer     NOT NULL DEFAULT 0,
    curated_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
    curated_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_portfolio_curations_one_target
        CHECK (num_nonnulls(achievement_id, portfolio_item_id) = 1)
);

-- One curation per item. Both target columns are nullable by design, so the
-- sentinel COALESCE is mandatory: without it two teachers could each attach a
-- different verdict to the same certificate and the report would print
-- whichever the planner returned first.
CREATE UNIQUE INDEX student_portfolio_curations_one_per_item
    ON student_portfolio_curations (
        COALESCE(achievement_id,    '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(portfolio_item_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE INDEX student_portfolio_curations_student
    ON student_portfolio_curations (institution_id, student_id, curated_at DESC);

-- ===========================================================================
-- 3. faculty.my_classes.montessori_early_years_tracking
-- ===========================================================================

-- The sequence of materials a child works through, per area.
--
-- The five classical areas are seeded below. sequence is the order of
-- presentation within an area and it is the whole point: "where is this child
-- in Sensorial" is a position in a list, not a score.
CREATE TABLE montessori_materials (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    area            text        NOT NULL
                                CHECK (area IN ('practical_life', 'sensorial', 'language',
                                                'mathematics', 'culture')),
    name            text        NOT NULL,
    description     text,
    sequence        integer     NOT NULL DEFAULT 0,
    -- Indicative months, both nullable. A guide does not hold a child back
    -- because they are 41 months rather than 42, but a material presented two
    -- years early is worth flagging on the screen.
    min_age_months  integer     CHECK (min_age_months IS NULL OR min_age_months >= 0),
    max_age_months  integer     CHECK (max_age_months IS NULL OR max_age_months > 0),
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT montessori_materials_name CHECK (nullif(btrim(name), '') IS NOT NULL),
    CONSTRAINT montessori_materials_age_order
        CHECK (min_age_months IS NULL OR max_age_months IS NULL
               OR max_age_months >= min_age_months)
);

CREATE UNIQUE INDEX montessori_materials_unique
    ON montessori_materials (institution_id, area, lower(btrim(name)));

CREATE INDEX montessori_materials_area
    ON montessori_materials (institution_id, area, sequence)
    WHERE is_active;

-- One observation of one child with one material, on one day.
--
-- Why this is not an extension of hpc_observations. That table is one rating
-- per observer per competency per term, on a 1-4 ordinal, and its unique index
-- enforces exactly that -- hpc_observations_one_per_observer keys on
-- (student, competency, observer_role, term, observed_by). A Montessori record
-- is the opposite shape: the same guide records the same child with the same
-- material repeatedly over months, and the sequence of those records IS the
-- assessment. Storing it in hpc_observations would mean either dropping that
-- unique index -- changing the meaning of a table three other features write --
-- or keeping only the most recent observation, which discards the only thing
-- anybody wants to see. The competency vocabulary is also wrong: a competency
-- is a disposition observed anywhere, a material is a specific object on a
-- specific shelf presented in a specific order.
--
-- stage is the three-step Montessori progression and nothing else. There is no
-- level, no mark and no percentage, because at three to six years old there is
-- nothing to put one on.
CREATE TABLE montessori_progress (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    material_id     uuid        NOT NULL REFERENCES montessori_materials(id) ON DELETE CASCADE,
    -- presented   the guide gave the lesson
    -- practising  the child has chosen it themselves since
    -- mastered    the child does it unaided and can show another child
    -- revisit     it had gone, and was given again. A real event, and hiding it
    --             inside 'presented' would lose the fact that it regressed.
    stage           text        NOT NULL
                                CHECK (stage IN ('presented', 'practising', 'mastered', 'revisit')),
    observed_on     date        NOT NULL DEFAULT CURRENT_DATE,
    -- The part a parent reads. A stage with no example is a checkbox.
    note            text,
    observed_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- One record of a given stage for a given child and material on a given day.
-- Deliberately NOT one row per child per material: the history is the record.
-- This only stops the double-tap on a slow connection.
CREATE UNIQUE INDEX montessori_progress_once_per_day
    ON montessori_progress (student_id, material_id, stage, observed_on);

CREATE INDEX montessori_progress_student
    ON montessori_progress (institution_id, student_id, observed_on DESC);

-- ===========================================================================
-- 4. faculty.attendance.offline_attendance_diary_capture
-- ===========================================================================

-- One sync of one device's queue.
--
-- The batch exists so a conflict has something to point at. A teacher told
-- "3 rows were rejected" needs to know which upload that was and what the
-- device thought the time was, because the whole question in a conflict is
-- which of two people marked the register first.
CREATE TABLE attendance_capture_batches (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id       uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    on_date          date        NOT NULL,
    -- The client's own idempotency key for this queue flush. A replay of the
    -- same batch after a dropped response must not double-write.
    client_batch_ref text        NOT NULL,
    -- When the teacher actually marked the register, per the device clock, as
    -- distinct from when it reached the server. Both are kept: the first is
    -- what the teacher will swear to, the second is what the audit shows.
    captured_at      timestamptz NOT NULL,
    synced_at        timestamptz NOT NULL DEFAULT now(),
    -- Free text from the client: "Field trip - Golconda", a device label.
    device_note      text,
    submitted_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    rows_accepted    integer     NOT NULL DEFAULT 0,
    rows_conflicted  integer     NOT NULL DEFAULT 0,
    CONSTRAINT attendance_capture_batches_ref
        CHECK (nullif(btrim(client_batch_ref), '') IS NOT NULL)
);

-- The idempotency key. Scoped per institution because two schools' devices may
-- pick the same uuid only through a bug, but the key is client-supplied text
-- and this table must not be a way to read another tenant's batch by guessing.
CREATE UNIQUE INDEX attendance_capture_batches_ref_once
    ON attendance_capture_batches (institution_id, client_batch_ref);

CREATE INDEX attendance_capture_batches_section
    ON attendance_capture_batches (institution_id, section_id, on_date DESC);

-- What the sync refused to overwrite, and what both sides said.
--
-- This is the honest half of the feature. A device that has been offline since
-- morning does not know the office already marked the child on leave, and
-- silently applying the later-arriving row would erase a decision made with
-- more information. So the row is rejected, kept here in full, and shown to the
-- teacher to resolve.
CREATE TABLE attendance_capture_conflicts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    batch_id        uuid        NOT NULL REFERENCES attendance_capture_batches(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    on_date         date        NOT NULL,
    -- What the device had.
    offline_status  text        NOT NULL,
    offline_remarks text,
    -- What the server already had, and who put it there.
    server_status   text        NOT NULL,
    server_marked_by uuid       REFERENCES users(id) ON DELETE SET NULL,
    server_marked_at timestamptz,
    -- pending  nobody has looked
    -- kept     the server row stands
    -- applied  the teacher chose the offline row and it was written
    resolution      text        NOT NULL DEFAULT 'pending'
                                CHECK (resolution IN ('pending', 'kept', 'applied')),
    resolved_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- One conflict row per child per batch. A replayed batch must not stack.
CREATE UNIQUE INDEX attendance_capture_conflicts_once
    ON attendance_capture_conflicts (batch_id, student_id);

CREATE INDEX attendance_capture_conflicts_open
    ON attendance_capture_conflicts (institution_id, on_date DESC)
    WHERE resolution = 'pending';

-- Where an attendance row came from.
--
-- Added to student_attendance rather than kept in a parallel table, because a
-- register with two homes is a register the office and the class teacher read
-- differently. marked_at already records when the server heard about it;
-- captured_at records when the teacher marked it, and the two differ by the
-- length of the field trip.
ALTER TABLE student_attendance
    ADD COLUMN IF NOT EXISTS captured_offline boolean NOT NULL DEFAULT false;
ALTER TABLE student_attendance
    ADD COLUMN IF NOT EXISTS captured_at timestamptz;
ALTER TABLE student_attendance
    ADD COLUMN IF NOT EXISTS capture_batch_id uuid
        REFERENCES attendance_capture_batches(id) ON DELETE SET NULL;

-- The other half of the diary. Attendance is who was there; the diary is what
-- was set, and a teacher on a trip writes both in the same notebook.
--
-- Not homework: homework has a due date, a submission and a grade, and a diary
-- line is often "bring a water bottle on Thursday". The kinds are kept apart so
-- a note never appears in a child's submission list.
CREATE TABLE class_diary_entries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id       uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    -- Nullable: "sports day rehearsal, no books" belongs to no subject, and
    -- forcing one files it under whichever the teacher had open.
    class_subject_id uuid        REFERENCES class_subjects(id) ON DELETE SET NULL,
    on_date          date        NOT NULL DEFAULT CURRENT_DATE,
    kind             text        NOT NULL DEFAULT 'note'
                                 CHECK (kind IN ('note', 'classwork', 'homework', 'reminder')),
    body             text        NOT NULL,
    -- The same offline provenance as the register above.
    captured_offline boolean     NOT NULL DEFAULT false,
    captured_at      timestamptz,
    capture_batch_id uuid        REFERENCES attendance_capture_batches(id) ON DELETE SET NULL,
    -- Whether families see it. Default true, because a diary nobody reads is a
    -- private notebook; a teacher can hold one back.
    is_visible_to_family boolean NOT NULL DEFAULT true,
    written_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT class_diary_entries_body CHECK (nullif(btrim(body), '') IS NOT NULL)
);

-- A replayed offline queue must not post the same line twice. class_subject_id
-- is nullable, hence the sentinel; the hash of the body keeps the key narrow
-- without truncating a long line into a collision with a different one.
CREATE UNIQUE INDEX class_diary_entries_no_duplicates
    ON class_diary_entries (
        section_id, on_date, kind,
        COALESCE(class_subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
        md5(btrim(body))
    );

CREATE INDEX class_diary_entries_section
    ON class_diary_entries (institution_id, section_id, on_date DESC);

-- ===========================================================================
-- 5. faculty.question_papers_online_tests.no_omr_exam_grading
-- ===========================================================================

-- Negative marking, per question, on the paper rather than in the bank.
--
-- Indian objective papers carry it and the fraction varies by paper: JEE-style
-- quarter marks in one test, none in the class quiz next week. It sits beside
-- online_test_questions.marks for the same reason marks does -- the same bank
-- question is worth different amounts on different papers.
ALTER TABLE online_test_questions
    ADD COLUMN IF NOT EXISTS negative_marks numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE online_test_questions
    DROP CONSTRAINT IF EXISTS online_test_questions_negative_marks;
ALTER TABLE online_test_questions
    ADD CONSTRAINT online_test_questions_negative_marks
        CHECK (negative_marks >= 0);

-- Partial credit on a multi-answer question. Off by default: most school papers
-- mark a multi-answer question all-or-nothing, and a teacher who wants
-- proportional credit is making a deliberate choice.
ALTER TABLE online_tests
    ADD COLUMN IF NOT EXISTS allow_partial_credit boolean NOT NULL DEFAULT false;

-- One child's sitting of one paper.
--
-- source is the reason this feature exists. 'online' is a child who sat the
-- test in the portal; 'key_entry' is a teacher typing the answers off a paper
-- script, which is what a school without an OMR scanner actually does. Both
-- grade through exactly the same code, which is the point -- an item analysis
-- computed two different ways is two different analyses.
CREATE TABLE online_test_attempts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    test_id         uuid        NOT NULL REFERENCES online_tests(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    attempt_no      integer     NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
    source          text        NOT NULL DEFAULT 'online'
                                CHECK (source IN ('online', 'key_entry')),
    status          text        NOT NULL DEFAULT 'in_progress'
                                CHECK (status IN ('in_progress', 'submitted', 'graded', 'void')),
    started_at      timestamptz NOT NULL DEFAULT now(),
    submitted_at    timestamptz,
    -- Both stored, not just the score. A percentage recomputed from a paper
    -- whose marks were edited afterwards is a different number from the one
    -- printed on the report, and the report is what the parent has.
    score           numeric(7,2),
    max_score       numeric(7,2),
    graded_at       timestamptz,
    graded_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    entered_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT online_test_attempts_score_range
        CHECK (score IS NULL OR max_score IS NULL OR score <= max_score)
);

-- One attempt number per child per test. Voided attempts keep their number --
-- a re-sit after a malpractice void is attempt 2, and renumbering would lose
-- the fact that there was a first.
CREATE UNIQUE INDEX online_test_attempts_once
    ON online_test_attempts (test_id, student_id, attempt_no);

CREATE INDEX online_test_attempts_test
    ON online_test_attempts (institution_id, test_id, status);

-- What the child put down for one question, and what it was worth.
--
-- selected_option_ids is an array because a multi-answer MCQ is a real
-- requirement and one row per selected option would make "answered but wrong"
-- indistinguishable from "not attempted" -- an empty array says the first, no
-- row at all says the second. That distinction is the whole basis of the
-- attempt rate in the item analysis, and negative marking must never touch an
-- unattempted question.
CREATE TABLE online_test_responses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    attempt_id      uuid        NOT NULL REFERENCES online_test_attempts(id) ON DELETE CASCADE,
    test_question_id uuid       NOT NULL REFERENCES online_test_questions(id) ON DELETE CASCADE,
    selected_option_ids uuid[]  NOT NULL DEFAULT '{}',
    -- A fill-in-the-blank answer typed rather than chosen. Graded against the
    -- option bodies of the correct options, case- and space-insensitively.
    text_response   text,
    is_correct      boolean,
    marks_awarded   numeric(6,2) NOT NULL DEFAULT 0,
    answered_at     timestamptz NOT NULL DEFAULT now()
);

-- One response per question per attempt. Re-answering updates the row.
CREATE UNIQUE INDEX online_test_responses_once
    ON online_test_responses (attempt_id, test_question_id);

CREATE INDEX online_test_responses_question
    ON online_test_responses (test_question_id, is_correct);

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE class_language_options          ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_language_options          FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_language_elections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_language_elections      FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_portfolio_curations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_portfolio_curations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE montessori_materials            ENABLE ROW LEVEL SECURITY;
ALTER TABLE montessori_materials            FORCE  ROW LEVEL SECURITY;
ALTER TABLE montessori_progress             ENABLE ROW LEVEL SECURITY;
ALTER TABLE montessori_progress             FORCE  ROW LEVEL SECURITY;
ALTER TABLE attendance_capture_batches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_capture_batches      FORCE  ROW LEVEL SECURITY;
ALTER TABLE attendance_capture_conflicts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_capture_conflicts    FORCE  ROW LEVEL SECURITY;
ALTER TABLE class_diary_entries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_diary_entries             FORCE  ROW LEVEL SECURITY;
ALTER TABLE online_test_attempts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_test_attempts            FORCE  ROW LEVEL SECURITY;
ALTER TABLE online_test_responses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_test_responses           FORCE  ROW LEVEL SECURITY;

CREATE POLICY class_language_options_tenant ON class_language_options
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY student_language_elections_tenant ON student_language_elections
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY student_portfolio_curations_tenant ON student_portfolio_curations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY montessori_materials_tenant ON montessori_materials
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY montessori_progress_tenant ON montessori_progress
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY attendance_capture_batches_tenant ON attendance_capture_batches
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY attendance_capture_conflicts_tenant ON attendance_capture_conflicts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY class_diary_entries_tenant ON class_diary_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY online_test_attempts_tenant ON online_test_attempts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY online_test_responses_tenant ON online_test_responses
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON
    class_language_options, student_language_elections,
    student_portfolio_curations,
    montessori_materials, montessori_progress,
    attendance_capture_batches, attendance_capture_conflicts,
    class_diary_entries,
    online_test_attempts, online_test_responses
    TO app_user;

-- ===========================================================================
-- Seeds
-- ===========================================================================

-- +goose StatementBegin
-- The classical Montessori sequence, so an early-years guide opening the screen
-- on day one has a shelf to record against rather than an empty table and a
-- setup page nobody has found. A school edits or deactivates what it does not
-- use; the names are the standard ones every AMI/AMS-trained guide knows.
DO $$
DECLARE
    inst uuid;
    m    record;
BEGIN
    FOR inst IN SELECT id FROM institutions LOOP
        FOR m IN
            SELECT * FROM (VALUES
                ('practical_life', 'Pouring dry',                10, 30, 48),
                ('practical_life', 'Pouring liquid',             20, 33, 54),
                ('practical_life', 'Spooning and tonging',       30, 30, 48),
                ('practical_life', 'Buttoning frame',            40, 36, 54),
                ('practical_life', 'Bow-tying frame',            50, 48, 72),
                ('practical_life', 'Sweeping and dusting',       60, 30, 60),
                ('practical_life', 'Washing hands',              70, 30, 54),
                ('sensorial',      'Knobbed cylinders',          10, 30, 48),
                ('sensorial',      'Pink tower',                 20, 33, 54),
                ('sensorial',      'Brown stair',                30, 36, 54),
                ('sensorial',      'Red rods',                   40, 36, 54),
                ('sensorial',      'Colour box 1 and 2',         50, 33, 54),
                ('sensorial',      'Geometric cabinet',          60, 42, 66),
                ('sensorial',      'Sound cylinders',            70, 36, 60),
                ('language',       'Sound games',                10, 30, 48),
                ('language',       'Sandpaper letters',          20, 36, 60),
                ('language',       'Movable alphabet',           30, 42, 66),
                ('language',       'Metal insets',               40, 42, 66),
                ('language',       'Phonetic object box',        50, 48, 66),
                ('language',       'Reading folders',            60, 54, 78),
                ('mathematics',    'Number rods',                10, 42, 60),
                ('mathematics',    'Sandpaper numerals',         20, 42, 60),
                ('mathematics',    'Spindle box',                30, 48, 66),
                ('mathematics',    'Cards and counters',         40, 48, 66),
                ('mathematics',    'Golden bead material',       50, 54, 78),
                ('mathematics',    'Teen and ten boards',        60, 54, 78),
                ('culture',        'Land, air and water',        10, 36, 60),
                ('culture',        'Sandpaper globe',            20, 42, 66),
                ('culture',        'Continent map',              30, 48, 72),
                ('culture',        'Parts of a plant',           40, 48, 72),
                ('culture',        'Living and non-living',      50, 42, 66)
            ) AS t(area, name, seq, min_m, max_m)
        LOOP
            INSERT INTO montessori_materials
                (institution_id, area, name, sequence, min_age_months, max_age_months)
            VALUES (inst, m.area, m.name, m.seq, m.min_m, m.max_m)
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down

DROP TABLE IF EXISTS online_test_responses;
DROP TABLE IF EXISTS online_test_attempts;
DROP TABLE IF EXISTS class_diary_entries;
DROP TABLE IF EXISTS attendance_capture_conflicts;
DROP TABLE IF EXISTS montessori_progress;
DROP TABLE IF EXISTS montessori_materials;
DROP TABLE IF EXISTS student_portfolio_curations;
DROP TABLE IF EXISTS student_language_elections;
DROP TABLE IF EXISTS class_language_options;

ALTER TABLE student_attendance
    DROP COLUMN IF EXISTS capture_batch_id,
    DROP COLUMN IF EXISTS captured_at,
    DROP COLUMN IF EXISTS captured_offline;

-- Dropped after student_attendance loses its reference to it.
DROP TABLE IF EXISTS attendance_capture_batches;

ALTER TABLE online_tests
    DROP COLUMN IF EXISTS allow_partial_credit;

ALTER TABLE online_test_questions
    DROP CONSTRAINT IF EXISTS online_test_questions_negative_marks;
ALTER TABLE online_test_questions
    DROP COLUMN IF EXISTS negative_marks;
